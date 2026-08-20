import { Injectable, Logger } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';
import type {
  CheckoutRequest,
  CheckoutSession,
  PaymentProvider,
  ProviderPayment,
  WebhookRequest,
} from './payment-provider.types';

/**
 * El proveedor por defecto: cobra de mentira.
 *
 * No es un stub de descarte, es el modo de desarrollo — el mismo criterio que
 * `LogMailProvider`. Arrancar el proyecto no debería exigir una cuenta de
 * Mercado Pago, y probar el flujo de seña en local tampoco. Cada checkout que
 * se crea acá queda con un pago **ya aprobado** esperando: se anota el id en el
 * log, se le pega al webhook con ese id a mano y el turno se confirma igual que
 * en producción.
 *
 * En tests es lo que permite ejercitar todo el cobro sin red. Los métodos
 * `program`, `failNext` y `reset` existen para eso y no los usa nada del código
 * de negocio.
 */
@Injectable()
export class SandboxPaymentProvider implements PaymentProvider {
  readonly name = 'sandbox';

  private readonly logger = new Logger(SandboxPaymentProvider.name);

  private readonly payments = new Map<string, ProviderPayment>();

  private sequence = 0;

  /** Mientras esté en `false`, todo aviso se considera no firmado. */
  private signaturesValid = true;

  createCheckout(request: CheckoutRequest): Promise<CheckoutSession> {
    this.sequence += 1;

    const checkoutId = `sandbox-checkout-${this.sequence}`;
    const paymentId = `sandbox-payment-${this.sequence}`;

    // El pago nace aprobado: el camino que interesa probar es el de después
    // del cobro. Para probar un rechazo, el test usa `program`.
    this.payments.set(paymentId, {
      providerPaymentId: paymentId,
      reference: request.reference,
      status: PaymentStatus.SUCCEEDED,
      amountCents: request.amountCents,
      currency: request.currency,
      paidAt: new Date(),
      failureReason: null,
      rawStatus: 'approved',
    });

    this.logger.log(
      { checkoutId, paymentId, reference: request.reference },
      'Checkout de mentira creado: pegale al webhook con este paymentId',
    );

    return Promise.resolve({
      providerCheckoutId: checkoutId,
      // Manda a donde iría un pago exitoso, así el link es clickeable en dev.
      checkoutUrl: `${request.successUrl}${request.successUrl.includes('?') ? '&' : '?'}sandbox=${encodeURIComponent(paymentId)}`,
    });
  }

  verifyWebhookSignature(): boolean {
    return this.signaturesValid;
  }

  /** Misma forma que un aviso de Mercado Pago, para que dev y prod se parezcan. */
  paymentIdFromWebhook(request: WebhookRequest): string | null {
    const body = (request.body ?? {}) as {
      type?: unknown;
      data?: { id?: unknown };
    };

    if (body.type !== 'payment') {
      return null;
    }

    const id = body.data?.id;

    return typeof id === 'string' && id ? id : null;
  }

  getPayment(providerPaymentId: string): Promise<ProviderPayment> {
    const payment = this.payments.get(providerPaymentId);

    if (!payment) {
      return Promise.reject(
        new Error(`El sandbox no conoce el pago ${providerPaymentId}`),
      );
    }

    return Promise.resolve(payment);
  }

  // ── Solo para tests y para probar a mano ──────────────────────────────────

  /** Fuerza el estado de un pago (para probar rechazos y devoluciones). */
  program(providerPaymentId: string, patch: Partial<ProviderPayment>): void {
    const current = this.payments.get(providerPaymentId);

    if (!current) {
      throw new Error(`El sandbox no conoce el pago ${providerPaymentId}`);
    }

    this.payments.set(providerPaymentId, { ...current, ...patch });
  }

  /** El id del pago que corresponde al último checkout creado. */
  lastPaymentId(): string {
    if (this.sequence === 0) {
      throw new Error('Todavía no se creó ningún checkout');
    }

    return `sandbox-payment-${this.sequence}`;
  }

  /** Simula avisos con firma inválida. */
  signaturesAre(valid: boolean): void {
    this.signaturesValid = valid;
  }

  reset(): void {
    this.payments.clear();
    this.sequence = 0;
    this.signaturesValid = true;
  }
}
