import { Logger } from '@nestjs/common';
import { PaymentStatus } from '@prisma/client';
import type { CheckoutRequest } from './payment-provider.types';
import { SandboxPaymentProvider } from './sandbox-payment.provider';

const CHECKOUT: CheckoutRequest = {
  reference: 'pago-1',
  title: 'Seña — Corte',
  amountCents: 30_000,
  currency: 'ARS',
  successUrl: 'https://app.test/pago/ok',
  failureUrl: 'https://app.test/pago/error',
  pendingUrl: 'https://app.test/pago/pendiente',
  notificationUrl: 'https://api.test/webhooks/mercadopago',
};

describe('SandboxPaymentProvider', () => {
  let provider: SandboxPaymentProvider;

  beforeEach(() => {
    // El sandbox loguea cada checkout (en dev es de donde sale el paymentId);
    // acá solo ensuciaría la salida del test.
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    provider = new SandboxPaymentProvider();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('cada checkout deja un pago ya aprobado esperando', async () => {
    await provider.createCheckout(CHECKOUT);

    const payment = await provider.getPayment(provider.lastPaymentId());

    expect(payment).toMatchObject({
      reference: 'pago-1',
      status: PaymentStatus.SUCCEEDED,
      amountCents: 30_000,
      currency: 'ARS',
    });
    expect(payment.paidAt).toBeInstanceOf(Date);
  });

  it('los ids no se repiten entre checkouts', async () => {
    const uno = await provider.createCheckout(CHECKOUT);
    const dos = await provider.createCheckout(CHECKOUT);

    expect(uno.providerCheckoutId).not.toBe(dos.providerCheckoutId);
  });

  /** En dev el link tiene que ser clickeable y llevar a donde iría un pago OK. */
  it('el link de checkout apunta a la URL de éxito', async () => {
    const session = await provider.createCheckout(CHECKOUT);

    expect(session.checkoutUrl).toContain('https://app.test/pago/ok');
    expect(session.checkoutUrl).toContain(provider.lastPaymentId());
  });

  it('`program` permite probar un rechazo', async () => {
    await provider.createCheckout(CHECKOUT);
    const id = provider.lastPaymentId();

    provider.program(id, {
      status: PaymentStatus.FAILED,
      paidAt: null,
      failureReason: 'cc_rejected_insufficient_amount',
      rawStatus: 'rejected',
    });

    await expect(provider.getPayment(id)).resolves.toMatchObject({
      status: PaymentStatus.FAILED,
      failureReason: 'cc_rejected_insufficient_amount',
    });
  });

  it('un pago que no existe es un error, no un pago vacío', async () => {
    await expect(provider.getPayment('no-existe')).rejects.toThrow();
  });

  it('lee el id del aviso con la misma forma que MP', () => {
    expect(
      provider.paymentIdFromWebhook({
        headers: {},
        query: {},
        body: { type: 'payment', data: { id: '112233445566' } },
      }),
    ).toBe('112233445566');
  });

  it('ignora los avisos que no son de un pago', () => {
    expect(
      provider.paymentIdFromWebhook({
        headers: {},
        query: {},
        body: { type: 'merchant_order', data: { id: '1' } },
      }),
    ).toBeNull();
  });

  it('puede simular una firma inválida', () => {
    expect(provider.verifyWebhookSignature()).toBe(true);

    provider.signaturesAre(false);

    expect(provider.verifyWebhookSignature()).toBe(false);
  });

  it('`reset` deja el sandbox como recién creado', async () => {
    await provider.createCheckout(CHECKOUT);
    provider.reset();

    expect(() => provider.lastPaymentId()).toThrow();
  });

  /**
   * El contador vive en memoria y `mpPaymentId` vive en la base: si un sandbox
   * nuevo reemitiera el id del anterior, el webhook del cobro de suscripción le
   * pegaría a la fila del pago de turno de la corrida pasada —que se busca
   * primero— y la suscripción no se confirmaría nunca. Es el bug que había en
   * dev, así que esto es lo que hay que romper para reintroducirlo.
   */
  it('un sandbox nuevo no reemite los ids del anterior', async () => {
    await provider.createCheckout(CHECKOUT);
    const antes = provider.lastPaymentId();

    provider.reset();
    await provider.createCheckout(CHECKOUT);

    expect(provider.lastPaymentId()).not.toBe(antes);

    const otroProceso = new SandboxPaymentProvider();
    await otroProceso.createCheckout(CHECKOUT);

    expect(otroProceso.lastPaymentId()).not.toBe(antes);
  });
});
