import { createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';
import {
  type CheckoutRequest,
  type CheckoutSession,
  type PaymentProvider,
  PaymentProviderError,
  type ProviderPayment,
  type WebhookRequest,
} from './payment-provider.types';

const API_BASE = 'https://api.mercadopago.com';

/** Igual que el proveedor de mail: `fetch` sin timeout es `fetch` colgado. */
const TIMEOUT_MS = 10_000;

/** Cuánto del cuerpo de un error se guarda en el mensaje. */
const MAX_ERROR_BODY = 500;

/** Un token de prueba de MP arranca con esto. */
const TEST_TOKEN_PREFIX = 'TEST-';

const CENTS_PER_UNIT = 100;

/**
 * Los estados de Mercado Pago, traducidos a los nuestros.
 *
 * Se exporta para poder testearlo: es la parte del proveedor que tiene lógica
 * de verdad, y la que rompe en silencio si MP suma un estado.
 *
 * Dos que merecen explicación:
 *
 * - **`authorized`** es plata reservada pero no capturada. Se trata como
 *   pendiente: todavía no entró.
 * - **`charged_back`** es un contracargo — el cliente desconoció el consumo y
 *   el banco devolvió la plata. Termina en `REFUNDED` porque el efecto sobre
 *   el saldo es el mismo; el motivo queda en `rawStatus`.
 */
const STATUS_MAP: Readonly<Record<string, PaymentStatus>> = {
  approved: PaymentStatus.SUCCEEDED,
  authorized: PaymentStatus.PENDING,
  pending: PaymentStatus.PENDING,
  in_process: PaymentStatus.PENDING,
  in_mediation: PaymentStatus.PENDING,
  rejected: PaymentStatus.FAILED,
  cancelled: PaymentStatus.FAILED,
  refunded: PaymentStatus.REFUNDED,
  charged_back: PaymentStatus.REFUNDED,
};

/**
 * Un estado que MP no documenta se trata como **pendiente**, nunca como
 * acreditado: dar por pagado algo que no entendemos es la peor forma de
 * equivocarse acá. Queda en el log con su nombre crudo.
 */
export function mapMercadoPagoStatus(rawStatus: string): PaymentStatus {
  return STATUS_MAP[rawStatus] ?? PaymentStatus.PENDING;
}

/**
 * El manifiesto que MP firma. El formato es de ellos:
 * `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`
 *
 * Las partes que no vienen **se omiten enteras**, incluido su nombre — no se
 * mandan vacías. Un manifiesto armado distinto da otro hash y rechaza avisos
 * legítimos, así que este formato es literal.
 */
export function buildSignatureManifest(parts: {
  dataId?: string;
  requestId?: string;
  ts?: string;
}): string {
  const segments: string[] = [];

  if (parts.dataId) {
    segments.push(`id:${parts.dataId};`);
  }
  if (parts.requestId) {
    segments.push(`request-id:${parts.requestId};`);
  }
  if (parts.ts) {
    segments.push(`ts:${parts.ts};`);
  }

  return segments.join('');
}

/** `ts=1704908010,v1=abc...` → sus dos partes. */
export function parseSignatureHeader(
  header: string,
): { ts: string; v1: string } | null {
  const values = new Map<string, string>();

  for (const part of header.split(',')) {
    const separator = part.indexOf('=');

    if (separator === -1) {
      continue;
    }

    values.set(
      part.slice(0, separator).trim(),
      part.slice(separator + 1).trim(),
    );
  }

  const ts = values.get('ts');
  const v1 = values.get('v1');

  return ts && v1 ? { ts, v1 } : null;
}

/** Comparación en tiempo constante. Longitudes distintas = no coincide. */
function hashesMatch(expected: string, received: string): boolean {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(received, 'utf8');

  return a.length === b.length && timingSafeEqual(a, b);
}

function header(request: WebhookRequest, name: string): string | undefined {
  // Node normaliza los headers entrantes a minúsculas, pero el objeto que llega
  // acá puede venir de otro lado (un test, un proxy): se busca de las dos.
  const value = request.headers[name] ?? request.headers[name.toLowerCase()];

  return Array.isArray(value) ? value[0] : value;
}

interface PreferenceResponse {
  id?: unknown;
  init_point?: unknown;
  sandbox_init_point?: unknown;
}

interface PaymentResponse {
  id?: unknown;
  status?: unknown;
  status_detail?: unknown;
  transaction_amount?: unknown;
  currency_id?: unknown;
  date_approved?: unknown;
  external_reference?: unknown;
}

/**
 * Mercado Pago por HTTP, sin SDK.
 *
 * Son tres llamadas (crear preferencia, leer pago) y un HMAC. El SDK oficial
 * traería su cadena de dependencias y su ritmo de breaking changes a cambio de
 * envolver `fetch`.
 *
 * **Nunca se confía en lo que dice el webhook.** El aviso trae un id; el estado
 * se pregunta con `getPayment`. Un aviso repetido o fuera de orden no puede
 * dejar un pago en un estado viejo.
 */
@Injectable()
export class MercadoPagoProvider implements PaymentProvider {
  readonly name = 'mercadopago';

  private readonly logger = new Logger(MercadoPagoProvider.name);

  constructor(
    private readonly accessToken: string,
    private readonly webhookSecret: string,
  ) {}

  /** Con credenciales de prueba, el link bueno es el de sandbox. */
  private get isSandbox(): boolean {
    return this.accessToken.startsWith(TEST_TOKEN_PREFIX);
  }

  async createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    const preference = await this.call<PreferenceResponse>(
      'POST',
      '/checkout/preferences',
      {
        items: [
          {
            title: request.title,
            quantity: 1,
            unit_price: request.amountCents / CENTS_PER_UNIT,
            currency_id: request.currency,
          },
        ],
        external_reference: request.reference,
        back_urls: {
          success: request.successUrl,
          failure: request.failureUrl,
          pending: request.pendingUrl,
        },
        auto_return: 'approved',
        notification_url: request.notificationUrl,
        ...(request.payerEmail ? { payer: { email: request.payerEmail } } : {}),
      },
    );

    const checkoutUrl = this.isSandbox
      ? preference.sandbox_init_point
      : preference.init_point;

    if (typeof preference.id !== 'string' || typeof checkoutUrl !== 'string') {
      throw new PaymentProviderError(
        'Mercado Pago creó la preferencia pero no devolvió id o link de pago',
        this.name,
      );
    }

    return { providerCheckoutId: preference.id, checkoutUrl };
  }

  /**
   * Verifica el HMAC del header `x-signature`.
   *
   * **No se valida que el `ts` sea reciente**, y es a propósito. Una ventana de
   * antirreplay protegería contra reenviar un aviso viejo, pero acá eso no hace
   * daño: el aviso solo dispara un `getPayment`, el estado sale de ahí y
   * `mp_payment_id` es único en la base. Reprocesar el mismo aviso no cambia
   * nada. En cambio, si MP reintenta una entrega firmada hace horas y nosotros
   * la rechazamos por vieja, **se pierde un pago**. Entre un replay inocuo y un
   * cobro perdido, la elección es clara.
   */
  verifyWebhookSignature(request: WebhookRequest): boolean {
    const raw = header(request, 'x-signature');

    if (!raw) {
      return false;
    }

    const signature = parseSignatureHeader(raw);

    if (!signature) {
      return false;
    }

    const manifest = buildSignatureManifest({
      // MP firma el `data.id` del query string, en minúsculas.
      dataId: request.query['data.id']?.toLowerCase(),
      requestId: header(request, 'x-request-id'),
      ts: signature.ts,
    });

    const expected = createHmac('sha256', this.webhookSecret)
      .update(manifest)
      .digest('hex');

    return hashesMatch(expected, signature.v1);
  }

  /**
   * MP manda avisos de varias cosas por el mismo endpoint. Solo los de tipo
   * `payment` nos interesan; el resto devuelve `null` y se ignora con un 200.
   */
  paymentIdFromWebhook(request: WebhookRequest): string | null {
    const body = (request.body ?? {}) as {
      type?: unknown;
      topic?: unknown;
      data?: { id?: unknown };
    };

    // `type` es el formato nuevo, `topic` el viejo. Los dos siguen llegando.
    const kind = body.type ?? body.topic ?? request.query.type;

    if (kind !== 'payment') {
      return null;
    }

    const fromBody = body.data?.id;

    if (typeof fromBody === 'string' && fromBody) {
      return fromBody;
    }

    // Algunos avisos traen el id solo en el query string.
    return request.query['data.id'] ?? request.query.id ?? null;
  }

  async getPayment(providerPaymentId: string): Promise<ProviderPayment> {
    const payment = await this.call<PaymentResponse>(
      'GET',
      `/v1/payments/${encodeURIComponent(providerPaymentId)}`,
    );

    const rawStatus =
      typeof payment.status === 'string' ? payment.status : 'unknown';
    const status = mapMercadoPagoStatus(rawStatus);

    if (!STATUS_MAP[rawStatus]) {
      this.logger.warn(
        { providerPaymentId, rawStatus },
        'Mercado Pago devolvió un estado que no conocemos: se trata como pendiente',
      );
    }

    const amount =
      typeof payment.transaction_amount === 'number'
        ? payment.transaction_amount
        : 0;

    const approvedAt =
      typeof payment.date_approved === 'string'
        ? new Date(payment.date_approved)
        : null;

    return {
      providerPaymentId,
      reference:
        typeof payment.external_reference === 'string'
          ? payment.external_reference
          : null,
      status,
      amountCents: Math.round(amount * CENTS_PER_UNIT),
      currency:
        typeof payment.currency_id === 'string' ? payment.currency_id : 'ARS',
      // `date_approved` solo viene cuando efectivamente se acreditó, pero se
      // cruza con el estado igual: la base tiene un CHECK que exige que los dos
      // digan lo mismo.
      paidAt:
        status === PaymentStatus.SUCCEEDED || status === PaymentStatus.REFUNDED
          ? (approvedAt ?? new Date())
          : null,
      failureReason:
        status === PaymentStatus.FAILED &&
        typeof payment.status_detail === 'string'
          ? payment.status_detail
          : null,
      rawStatus,
    };
  }

  private async call<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    let response: Response;

    try {
      response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      // Timeout, DNS, TLS: el proveedor no contestó.
      throw new PaymentProviderError(
        `No se pudo contactar a Mercado Pago (${method} ${path})`,
        this.name,
        error,
      );
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');

      throw new PaymentProviderError(
        `Mercado Pago respondió ${response.status} a ${method} ${path}: ${detail.slice(0, MAX_ERROR_BODY)}`,
        this.name,
      );
    }

    return (await response.json()) as T;
  }
}
