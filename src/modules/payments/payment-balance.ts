import { AppointmentPaymentType, PaymentStatus } from '@prisma/client';

/**
 * Cuánto se pagó de un turno.
 *
 * **Esta es la única definición válida.** El saldo sale de sumar filas, nunca
 * de leer un campo, y hay dos formas de representar plata que vuelve — que es
 * exactamente por lo que esto vive en un solo lugar y es una función pura:
 *
 * - Una fila con `status = REFUNDED` es un pago que **el proveedor revirtió
 *   entero**. No suma ni resta: es como si no hubiera pasado.
 * - Una fila con `paymentType = REFUND` y `status = SUCCEEDED` es una
 *   devolución hecha por nosotros (parcial, o en efectivo en el mostrador).
 *   Esa **resta**.
 *
 * Todo se guarda en positivo: el signo lo pone el tipo, no el número. La base
 * lo garantiza con un CHECK (`amount_cents > 0`).
 */

/** Lo mínimo que hace falta de un pago. Un `AppointmentPayment` encaja solo. */
export interface CountablePayment {
  amountCents: number;
  paymentType: AppointmentPaymentType;
  status: PaymentStatus;
}

/** Los tres cortes de plata que sale de un conjunto de pagos cualquiera. */
export interface PaymentTotals {
  /** Lo que se cobró, sin descontar nada. */
  chargedCents: number;
  /** Lo que volvió al cliente, por cualquiera de las dos vías. */
  refundedCents: number;
  /** Lo que quedó en la caja: cobrado menos devoluciones. */
  netCents: number;
}

export interface AppointmentBalance {
  /** Lo que quedó en la caja: entradas menos devoluciones. */
  paidCents: number;
  /** Lo que volvió al cliente, por cualquiera de las dos vías. */
  refundedCents: number;
  /** Lo que falta para cubrir el total. Nunca negativo. */
  dueCents: number;
  /** Si la seña está cubierta. Sin seña configurada, siempre `true`. */
  depositCovered: boolean;
  fullyPaid: boolean;
}

const isRefund = (payment: CountablePayment): boolean =>
  payment.paymentType === AppointmentPaymentType.REFUND;

const settled = (payment: CountablePayment): boolean =>
  payment.status === PaymentStatus.SUCCEEDED;

const sum = (payments: readonly CountablePayment[]): number =>
  payments.reduce((total, payment) => total + payment.amountCents, 0);

/**
 * Qué fila suma y qué fila resta. **Es la regla de arriba, y nada más.**
 *
 * Vive separada de `appointmentBalance` porque el saldo de un turno no es el
 * único que la necesita: el listado de cobros por rango
 * (`GET /payments`) suma plata de muchos turnos a la vez y no tiene un
 * `totalPriceCents` contra el cual medir. Sin este corte, ese listado tendría
 * que sumar a mano y aparecería una **segunda** definición de "cuánto entró",
 * que es el error clásico de esta tabla.
 *
 * Sirve igual para un turno, para un mes o para una fila sola.
 */
export function paymentTotals(
  payments: readonly CountablePayment[],
): PaymentTotals {
  const inflow = sum(payments.filter((p) => settled(p) && !isRefund(p)));
  const outflow = sum(payments.filter((p) => settled(p) && isRefund(p)));

  // Un pago que el proveedor revirtió también es plata que volvió, aunque no
  // tenga una fila de devolución propia. No entra en `chargedCents` —`settled`
  // lo deja afuera—, así que restarlo del neto lo contaría dos veces.
  const reversed = sum(
    payments.filter((p) => p.status === PaymentStatus.REFUNDED && !isRefund(p)),
  );

  return {
    chargedCents: inflow,
    refundedCents: outflow + reversed,
    netCents: inflow - outflow,
  };
}

export function appointmentBalance(
  appointment: {
    totalPriceCents: number;
    depositAmountCents: number | null;
  },
  payments: readonly CountablePayment[],
): AppointmentBalance {
  const { netCents: paidCents, refundedCents } = paymentTotals(payments);

  return {
    paidCents,
    refundedCents,
    // Puede dar más que el total si las devoluciones superan lo cobrado, y está
    // bien: significa que le debemos plata al cliente.
    dueCents: Math.max(0, appointment.totalPriceCents - paidCents),
    depositCovered:
      appointment.depositAmountCents === null ||
      paidCents >= appointment.depositAmountCents,
    fullyPaid: paidCents >= appointment.totalPriceCents,
  };
}
