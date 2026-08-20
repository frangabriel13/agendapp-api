import { PaymentStatus } from '@prisma/client';
import {
  buildSignatureManifest,
  mapMercadoPagoStatus,
  MercadoPagoProvider,
  parseSignatureHeader,
} from './mercadopago.provider';
import type { WebhookRequest } from './payment-provider.types';

const SECRET = 'secreto-de-prueba';

/**
 * Vector calculado a mano sobre el manifiesto
 * `id:12345;request-id:req-abc;ts:1704908010;`.
 *
 * Está hardcodeado a propósito: si estuviera calculado dentro del test con el
 * mismo código que verifica, el test pasaría igual con el formato de manifiesto
 * equivocado — que es exactamente el bug que MP haría rechazar todos los avisos.
 */
const VALID_HASH =
  'be9b31e5ebf2a679e82777d3c46878efc82a6c2737c736fd98ad27700516013b';

/** El mismo manifiesto sin `request-id`. */
const HASH_WITHOUT_REQUEST_ID =
  '63cb22e3bfaf8208e7294e29bbf25824e812c0905fd63dab864d2c6416f7804f';

function webhook(overrides: Partial<WebhookRequest> = {}): WebhookRequest {
  return {
    headers: {
      'x-signature': `ts=1704908010,v1=${VALID_HASH}`,
      'x-request-id': 'req-abc',
    },
    query: { 'data.id': '12345', type: 'payment' },
    body: { type: 'payment', data: { id: '12345' } },
    ...overrides,
  };
}

describe('mapMercadoPagoStatus', () => {
  it('approved es el único que acredita', () => {
    expect(mapMercadoPagoStatus('approved')).toBe(PaymentStatus.SUCCEEDED);
  });

  it('authorized todavía no entró: es pendiente', () => {
    expect(mapMercadoPagoStatus('authorized')).toBe(PaymentStatus.PENDING);
  });

  it.each(['pending', 'in_process', 'in_mediation'])(
    '%s es pendiente',
    (raw) => {
      expect(mapMercadoPagoStatus(raw)).toBe(PaymentStatus.PENDING);
    },
  );

  it.each(['rejected', 'cancelled'])('%s es fallido', (raw) => {
    expect(mapMercadoPagoStatus(raw)).toBe(PaymentStatus.FAILED);
  });

  it('un contracargo termina como devolución', () => {
    expect(mapMercadoPagoStatus('charged_back')).toBe(PaymentStatus.REFUNDED);
    expect(mapMercadoPagoStatus('refunded')).toBe(PaymentStatus.REFUNDED);
  });

  /**
   * Lo importante no es que sea `PENDING`, es que **no** sea `SUCCEEDED`: dar
   * por cobrado un estado que no conocemos es la peor forma de equivocarse acá.
   */
  it('un estado desconocido nunca se da por cobrado', () => {
    expect(mapMercadoPagoStatus('algo_nuevo_de_mp')).toBe(
      PaymentStatus.PENDING,
    );
    expect(mapMercadoPagoStatus('')).toBe(PaymentStatus.PENDING);
  });
});

describe('parseSignatureHeader', () => {
  it('parte el header en sus dos valores', () => {
    expect(parseSignatureHeader('ts=123,v1=abc')).toEqual({
      ts: '123',
      v1: 'abc',
    });
  });

  it('tolera los espacios que mete MP', () => {
    expect(parseSignatureHeader('ts=123, v1=abc')).toEqual({
      ts: '123',
      v1: 'abc',
    });
  });

  it('sin v1 no hay firma que verificar', () => {
    expect(parseSignatureHeader('ts=123')).toBeNull();
    expect(parseSignatureHeader('cualquier cosa')).toBeNull();
  });
});

describe('buildSignatureManifest', () => {
  it('arma las tres partes en orden', () => {
    expect(
      buildSignatureManifest({
        dataId: '12345',
        requestId: 'req-abc',
        ts: '1704908010',
      }),
    ).toBe('id:12345;request-id:req-abc;ts:1704908010;');
  });

  /** Las partes ausentes se omiten enteras, no van vacías. */
  it('omite lo que no vino', () => {
    expect(buildSignatureManifest({ dataId: '12345', ts: '1704908010' })).toBe(
      'id:12345;ts:1704908010;',
    );
    expect(buildSignatureManifest({})).toBe('');
  });
});

describe('MercadoPagoProvider', () => {
  const provider = new MercadoPagoProvider('TEST-token', SECRET);

  describe('verifyWebhookSignature', () => {
    it('acepta una firma válida', () => {
      expect(provider.verifyWebhookSignature(webhook())).toBe(true);
    });

    it('acepta un aviso sin x-request-id', () => {
      expect(
        provider.verifyWebhookSignature(
          webhook({
            headers: {
              'x-signature': `ts=1704908010,v1=${HASH_WITHOUT_REQUEST_ID}`,
            },
          }),
        ),
      ).toBe(true);
    });

    it('rechaza una firma que no coincide', () => {
      expect(
        provider.verifyWebhookSignature(
          webhook({
            headers: {
              'x-signature':
                'ts=1704908010,v1=00000000000000000000000000000000',
              'x-request-id': 'req-abc',
            },
          }),
        ),
      ).toBe(false);
    });

    /** Cambiar el id sin recalcular la firma es el ataque obvio. */
    it('rechaza si le cambiaron el data.id', () => {
      expect(
        provider.verifyWebhookSignature(
          webhook({ query: { 'data.id': '99999', type: 'payment' } }),
        ),
      ).toBe(false);
    });

    it('rechaza un aviso sin firma', () => {
      expect(provider.verifyWebhookSignature(webhook({ headers: {} }))).toBe(
        false,
      );
    });

    it('rechaza si el secreto es otro', () => {
      const otro = new MercadoPagoProvider('TEST-token', 'otro-secreto');

      expect(otro.verifyWebhookSignature(webhook())).toBe(false);
    });
  });

  describe('paymentIdFromWebhook', () => {
    it('saca el id del cuerpo', () => {
      expect(provider.paymentIdFromWebhook(webhook())).toBe('12345');
    });

    it('cae al query string si el cuerpo no lo trae', () => {
      expect(
        provider.paymentIdFromWebhook(
          webhook({ body: { type: 'payment' }, query: { 'data.id': '777' } }),
        ),
      ).toBe('777');
    });

    it('entiende el formato viejo con `topic`', () => {
      expect(
        provider.paymentIdFromWebhook(
          webhook({ body: { topic: 'payment', data: { id: '555' } } }),
        ),
      ).toBe('555');
    });

    /**
     * MP manda avisos de otras cosas por el mismo endpoint. Eso no es un error:
     * se contesta 200 y se ignora.
     */
    it('devuelve null cuando el aviso no es de un pago', () => {
      expect(
        provider.paymentIdFromWebhook(
          webhook({
            body: { type: 'merchant_order', data: { id: '1' } },
            query: {},
          }),
        ),
      ).toBeNull();
    });
  });

  describe('getPayment', () => {
    /** Responde lo que MP respondería, sin salir a la red. */
    function respondWith(payload: unknown, ok = true, status = 200): void {
      jest.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok,
        status,
        json: () => Promise.resolve(payload),
        text: () => Promise.resolve(JSON.stringify(payload)),
      } as Response);
    }

    afterEach(() => {
      jest.restoreAllMocks();
    });

    /**
     * MP maneja unidades con decimales y nosotros centavos enteros. Es el punto
     * donde un error de conversión cobra cien veces de más sin que nada falle.
     */
    it('convierte el monto de unidades a centavos', async () => {
      respondWith({
        status: 'approved',
        transaction_amount: 1500.5,
        currency_id: 'ARS',
        date_approved: '2026-08-20T15:00:00.000Z',
        external_reference: 'pago-1',
      });

      const payment = await provider.getPayment('123');

      expect(payment.amountCents).toBe(150_050);
      expect(payment.currency).toBe('ARS');
      expect(payment.reference).toBe('pago-1');
      expect(payment.status).toBe(PaymentStatus.SUCCEEDED);
      expect(payment.paidAt).toEqual(new Date('2026-08-20T15:00:00.000Z'));
    });

    it('un rechazo trae el motivo y no trae fecha de acreditación', async () => {
      respondWith({
        status: 'rejected',
        status_detail: 'cc_rejected_insufficient_amount',
        transaction_amount: 100,
        currency_id: 'ARS',
      });

      const payment = await provider.getPayment('123');

      expect(payment.status).toBe(PaymentStatus.FAILED);
      expect(payment.failureReason).toBe('cc_rejected_insufficient_amount');
      expect(payment.paidAt).toBeNull();
      expect(payment.rawStatus).toBe('rejected');
    });

    it('un pago pendiente no trae fecha de acreditación', async () => {
      respondWith({ status: 'in_process', transaction_amount: 100 });

      const payment = await provider.getPayment('123');

      expect(payment.status).toBe(PaymentStatus.PENDING);
      expect(payment.paidAt).toBeNull();
    });

    /**
     * La base tiene un CHECK que exige que `status` y `paid_at` digan lo mismo.
     * Si MP acredita un pago sin `date_approved`, el insert fallaría con un
     * error de constraint en vez de guardar el cobro.
     */
    it('si acredita sin fecha, se usa el momento actual', async () => {
      respondWith({ status: 'approved', transaction_amount: 100 });

      const payment = await provider.getPayment('123');

      expect(payment.status).toBe(PaymentStatus.SUCCEEDED);
      expect(payment.paidAt).toBeInstanceOf(Date);
    });

    it('un error del proveedor no se confunde con un pago rechazado', async () => {
      respondWith({ message: 'invalid token' }, false, 401);

      await expect(provider.getPayment('123')).rejects.toThrow(
        /Mercado Pago respondió 401/,
      );
    });

    it('una caída de red tampoco', async () => {
      jest
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('ECONNREFUSED'));

      await expect(provider.getPayment('123')).rejects.toThrow(
        /No se pudo contactar a Mercado Pago/,
      );
    });
  });
});
