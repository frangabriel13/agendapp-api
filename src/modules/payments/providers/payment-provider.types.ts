import type { PaymentStatus } from '@prisma/client';

/**
 * El contrato entre "quiero cobrar" y el proveedor que cobra.
 *
 * A propósito no habla de Mercado Pago: nada acá dice "preferencia", que es
 * vocabulario de MP. La razón principal de que exista esta interfaz **no** es
 * poder cambiar de proveedor —en Argentina, MP es el que hay— sino poder
 * ejercitar todo el flujo de cobro sin red: en tests y en desarrollo corre
 * `SandboxPaymentProvider` y el código de negocio es exactamente el mismo.
 *
 * El estado se reusa de Prisma (`PaymentStatus`) en vez de definir un enum
 * paralelo. Dos vocabularios para lo mismo terminan divergiendo, y traducir
 * entre ellos sería trabajo que no compra nada.
 */

/** Lo que hay que saber para armar un checkout. */
export interface CheckoutRequest {
  /**
   * Nuestra referencia, que el proveedor nos devuelve intacta en el webhook.
   * Es el id de la fila de `appointment_payments`: es lo que permite saber qué
   * estábamos cobrando cuando llega el aviso.
   */
  reference: string;
  /** Lo que ve el cliente en el checkout ("Seña — Corte y brushing"). */
  title: string;
  amountCents: number;
  /** ISO 4217 en mayúsculas, copiada del tenant. */
  currency: string;
  payerEmail?: string;
  /** A dónde vuelve el cliente según cómo le fue. Son URLs del frontend. */
  successUrl: string;
  failureUrl: string;
  pendingUrl: string;
  /** A dónde avisa el proveedor. Tiene que ser pública: en dev, un túnel. */
  notificationUrl: string;
}

export interface CheckoutSession {
  /** El id del checkout del lado del proveedor. */
  providerCheckoutId: string;
  /** El link al que se manda al cliente. */
  checkoutUrl: string;
}

/** Un pago tal como lo ve el proveedor, ya traducido a nuestro vocabulario. */
export interface ProviderPayment {
  providerPaymentId: string;
  /** El `reference` que mandamos al crear el checkout. */
  reference: string | null;
  status: PaymentStatus;
  amountCents: number;
  currency: string;
  /** Cuándo se acreditó. `null` mientras no esté acreditado. */
  paidAt: Date | null;
  failureReason: string | null;
  /**
   * El estado crudo del proveedor, sin traducir. Va al log: cuando un pago
   * queda en un estado raro, `PENDING` no dice nada y `in_mediation` sí.
   */
  rawStatus: string;
}

/**
 * Un aviso del proveedor, tal como llegó.
 *
 * No incluye el cuerpo crudo sin parsear: MP firma un manifiesto armado con
 * headers y query params, no el body, así que hoy nadie lo necesita y tenerlo
 * obligaría a levantar la app con `rawBody: true`. Un proveedor que firme el
 * body va a necesitar sumarlo — y ese es el momento de hacerlo, no ahora.
 */
export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, string | undefined>;
  body: unknown;
}

export interface PaymentProvider {
  /** Para poder loguear con qué proveedor se hizo cada cosa. */
  readonly name: string;

  /** Crea el checkout y devuelve el link al que mandar al cliente. */
  createCheckout(request: CheckoutRequest): Promise<CheckoutSession>;

  /**
   * Si el aviso viene realmente del proveedor.
   *
   * Sin esto, el webhook es un endpoint público donde cualquiera puede avisar
   * "este turno ya se pagó". **Un aviso que no verifica no se procesa**, ni
   * siquiera para loguearlo como pago.
   */
  verifyWebhookSignature(request: WebhookRequest): boolean;

  /**
   * De qué pago habla el aviso. `null` cuando el aviso no es de un pago (MP
   * manda avisos de otras cosas por el mismo endpoint) — eso se responde 200 y
   * se ignora, no es un error.
   */
  paymentIdFromWebhook(request: WebhookRequest): string | null;

  /**
   * El estado real del pago, preguntado al proveedor.
   *
   * El webhook trae un id, no un estado: **la fuente de verdad es esta
   * llamada**. Confiar en lo que dice el aviso permitiría que un aviso
   * repetido o desordenado dejara un pago en un estado que ya no tiene.
   */
  getPayment(providerPaymentId: string): Promise<ProviderPayment>;
}

/**
 * El proveedor no pudo responder o respondió algo que no entendemos.
 *
 * Es distinto de "el pago fue rechazado", que es un `ProviderPayment` con
 * `status: FAILED` y no una excepción: un rechazo es información, una caída es
 * un problema.
 */
export class PaymentProviderError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PaymentProviderError';
  }
}

/** Token de inyección: `PaymentProvider` es una interfaz y no existe en runtime. */
export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');
