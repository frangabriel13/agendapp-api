import { AppointmentPaymentType, PaymentStatus } from '@prisma/client';
import {
  appointmentBalance,
  paymentTotals,
  type CountablePayment,
} from './payment-balance';

const { DEPOSIT, FULL, REMAINDER, REFUND } = AppointmentPaymentType;
const { PENDING, SUCCEEDED, FAILED, REFUNDED } = PaymentStatus;

/** Un turno de $1.000 con seña de $300. */
const TURNO = { totalPriceCents: 100_000, depositAmountCents: 30_000 };

const pago = (
  amountCents: number,
  paymentType: AppointmentPaymentType = FULL,
  status: PaymentStatus = SUCCEEDED,
): CountablePayment => ({ amountCents, paymentType, status });

describe('appointmentBalance', () => {
  it('sin pagos, se debe todo', () => {
    expect(appointmentBalance(TURNO, [])).toEqual({
      paidCents: 0,
      refundedCents: 0,
      dueCents: 100_000,
      depositCovered: false,
      fullyPaid: false,
    });
  });

  it('la seña cubre la seña pero no el total', () => {
    const balance = appointmentBalance(TURNO, [pago(30_000, DEPOSIT)]);

    expect(balance.paidCents).toBe(30_000);
    expect(balance.dueCents).toBe(70_000);
    expect(balance.depositCovered).toBe(true);
    expect(balance.fullyPaid).toBe(false);
  });

  it('seña más saldo cierra el turno', () => {
    const balance = appointmentBalance(TURNO, [
      pago(30_000, DEPOSIT),
      pago(70_000, REMAINDER),
    ]);

    expect(balance).toMatchObject({
      paidCents: 100_000,
      dueCents: 0,
      fullyPaid: true,
    });
  });

  describe('solo cuentan los pagos acreditados', () => {
    it('un pago pendiente no cuenta', () => {
      const balance = appointmentBalance(TURNO, [pago(100_000, FULL, PENDING)]);

      expect(balance.paidCents).toBe(0);
      expect(balance.fullyPaid).toBe(false);
    });

    it('un pago rechazado no cuenta', () => {
      expect(
        appointmentBalance(TURNO, [pago(100_000, FULL, FAILED)]).paidCents,
      ).toBe(0);
    });
  });

  /**
   * Las dos formas de representar plata que vuelve. Que existan las dos es
   * justo lo que hace que esto tenga que vivir en un solo lugar.
   */
  describe('devoluciones', () => {
    it('un pago revertido por el proveedor cuenta como cero', () => {
      const balance = appointmentBalance(TURNO, [
        pago(100_000, FULL, REFUNDED),
      ]);

      expect(balance.paidCents).toBe(0);
      expect(balance.refundedCents).toBe(100_000);
      expect(balance.dueCents).toBe(100_000);
    });

    it('una devolución nuestra resta', () => {
      const balance = appointmentBalance(TURNO, [
        pago(100_000, FULL),
        pago(40_000, REFUND),
      ]);

      expect(balance.paidCents).toBe(60_000);
      expect(balance.refundedCents).toBe(40_000);
      expect(balance.dueCents).toBe(40_000);
      expect(balance.fullyPaid).toBe(false);
    });

    it('devolver la seña la descubre', () => {
      const balance = appointmentBalance(TURNO, [
        pago(30_000, DEPOSIT),
        pago(30_000, REFUND),
      ]);

      expect(balance.paidCents).toBe(0);
      expect(balance.depositCovered).toBe(false);
    });

    /**
     * Devolver más de lo cobrado deja el saldo en negativo, y está bien: no se
     * recorta a cero porque significa que le debemos plata al cliente, que es
     * información, no un error de cálculo.
     */
    it('devolver de más deja el pagado en negativo', () => {
      const balance = appointmentBalance(TURNO, [
        pago(30_000, DEPOSIT),
        pago(50_000, REFUND),
      ]);

      expect(balance.paidCents).toBe(-20_000);
      expect(balance.dueCents).toBe(120_000);
    });

    it('una devolución pendiente todavía no resta', () => {
      const balance = appointmentBalance(TURNO, [
        pago(100_000, FULL),
        pago(40_000, REFUND, PENDING),
      ]);

      expect(balance.paidCents).toBe(100_000);
      expect(balance.refundedCents).toBe(0);
    });
  });

  describe('casos borde', () => {
    it('sin seña configurada, la seña está cubierta', () => {
      const balance = appointmentBalance(
        { totalPriceCents: 100_000, depositAmountCents: null },
        [],
      );

      expect(balance.depositCovered).toBe(true);
    });

    it('pagar de más no deja saldo negativo a cobrar', () => {
      const balance = appointmentBalance(TURNO, [pago(150_000, FULL)]);

      expect(balance.paidCents).toBe(150_000);
      expect(balance.dueCents).toBe(0);
      expect(balance.fullyPaid).toBe(true);
    });

    it('un turno gratis está pago desde el principio', () => {
      const balance = appointmentBalance(
        { totalPriceCents: 0, depositAmountCents: null },
        [],
      );

      expect(balance.fullyPaid).toBe(true);
      expect(balance.dueCents).toBe(0);
    });
  });
});

/**
 * `paymentTotals` es la misma regla sin el turno alrededor: la usa el listado
 * por rango, que suma plata de muchos turnos y no tiene un precio contra el
 * cual medir. Estos tests fijan **el corte**, no el saldo.
 */
describe('paymentTotals', () => {
  it('sin pagos, todo en cero', () => {
    expect(paymentTotals([])).toEqual({
      chargedCents: 0,
      refundedCents: 0,
      netCents: 0,
    });
  });

  it('suma los acreditados de cualquier tipo', () => {
    expect(
      paymentTotals([pago(30_000, DEPOSIT), pago(70_000, REMAINDER)]),
    ).toEqual({ chargedCents: 100_000, refundedCents: 0, netCents: 100_000 });
  });

  it('un pago pendiente o fallado no entra', () => {
    expect(
      paymentTotals([
        pago(50_000, FULL, SUCCEEDED),
        pago(30_000, FULL, PENDING),
        pago(20_000, FULL, FAILED),
      ]),
    ).toEqual({ chargedCents: 50_000, refundedCents: 0, netCents: 50_000 });
  });

  it('una devolución nuestra resta del neto y suma a lo devuelto', () => {
    expect(paymentTotals([pago(100_000, FULL), pago(40_000, REFUND)])).toEqual({
      chargedCents: 100_000,
      refundedCents: 40_000,
      netCents: 60_000,
    });
  });

  /**
   * El error clásico de esta tabla: un pago revertido por el proveedor **no**
   * entra en lo cobrado —`REFUNDED` no está acreditado—, así que restarlo del
   * neto lo contaría dos veces y el mes cerraría de menos.
   */
  it('un pago revertido por el proveedor no se cuenta dos veces', () => {
    expect(
      paymentTotals([pago(100_000, FULL), pago(25_000, FULL, REFUNDED)]),
    ).toEqual({
      chargedCents: 100_000,
      refundedCents: 25_000,
      netCents: 100_000,
    });
  });

  it('las dos formas de devolver conviven', () => {
    expect(
      paymentTotals([
        pago(100_000, FULL),
        pago(25_000, FULL, REFUNDED),
        pago(10_000, REFUND),
      ]),
    ).toEqual({
      chargedCents: 100_000,
      refundedCents: 35_000,
      netCents: 90_000,
    });
  });

  it('devolver más de lo cobrado deja el neto negativo', () => {
    expect(paymentTotals([pago(30_000, FULL), pago(50_000, REFUND)])).toEqual({
      chargedCents: 30_000,
      refundedCents: 50_000,
      netCents: -20_000,
    });
  });

  it('una devolución todavía pendiente no resta', () => {
    expect(
      paymentTotals([pago(100_000, FULL), pago(40_000, REFUND, PENDING)]),
    ).toEqual({ chargedCents: 100_000, refundedCents: 0, netCents: 100_000 });
  });
});
