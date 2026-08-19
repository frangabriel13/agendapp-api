import { AppointmentStatus, CancellationRefundType } from '@prisma/client';
import {
  allowedTransitions,
  canTransition,
  isCanceled,
  isTerminal,
  resolveRefund,
  type CancellationPolicy,
} from './status-machine';

const {
  PENDING_PAYMENT,
  CONFIRMED,
  ATTENDED,
  NO_SHOW,
  CANCELED_BY_CUSTOMER,
  CANCELED_BY_BUSINESS,
  RESCHEDULED,
} = AppointmentStatus;

describe('transiciones', () => {
  it('un turno esperando la seña se confirma o se cancela', () => {
    expect(allowedTransitions(PENDING_PAYMENT)).toEqual([
      CONFIRMED,
      CANCELED_BY_CUSTOMER,
      CANCELED_BY_BUSINESS,
    ]);
  });

  it('un turno confirmado termina atendido, ausente o cancelado', () => {
    expect(allowedTransitions(CONFIRMED)).toEqual([
      ATTENDED,
      NO_SHOW,
      CANCELED_BY_CUSTOMER,
      CANCELED_BY_BUSINESS,
    ]);
  });

  it.each([
    ATTENDED,
    NO_SHOW,
    CANCELED_BY_CUSTOMER,
    CANCELED_BY_BUSINESS,
    RESCHEDULED,
  ])('%s es terminal', (status) => {
    expect(isTerminal(status)).toBe(true);
    expect(allowedTransitions(status)).toEqual([]);
  });

  it('no se puede volver atrás', () => {
    expect(canTransition(ATTENDED, CONFIRMED)).toBe(false);
    expect(canTransition(CANCELED_BY_CUSTOMER, CONFIRMED)).toBe(false);
  });

  it('no se puede saltear el pago de la seña hacia atendido', () => {
    expect(canTransition(PENDING_PAYMENT, ATTENDED)).toBe(false);
  });

  /**
   * A `rescheduled` se llega reprogramando, que además crea el turno nuevo.
   * Si fuera una transición suelta se podría marcar un turno como reprogramado
   * sin que exista el reemplazo.
   */
  it('a rescheduled no se llega con un cambio de estado', () => {
    expect(canTransition(CONFIRMED, RESCHEDULED)).toBe(false);
    expect(canTransition(PENDING_PAYMENT, RESCHEDULED)).toBe(false);
  });

  it('quedarse donde uno está tampoco es una transición', () => {
    expect(canTransition(CONFIRMED, CONFIRMED)).toBe(false);
  });

  it('los dos cancelados cuentan como cancelación', () => {
    expect(isCanceled(CANCELED_BY_CUSTOMER)).toBe(true);
    expect(isCanceled(CANCELED_BY_BUSINESS)).toBe(true);
    expect(isCanceled(RESCHEDULED)).toBe(false);
  });
});

describe('resolveRefund', () => {
  const EN_DOS_DIAS = new Date('2026-09-10T14:00:00.000Z');
  const AHORA = new Date('2026-09-08T14:00:00.000Z'); // 48 h antes

  const conSeña = {
    startsAt: EN_DOS_DIAS,
    depositAmountCents: 500_000,
    depositPaid: true,
  };

  const politica = (
    over: Partial<CancellationPolicy> = {},
  ): CancellationPolicy => ({
    cancellationPolicyHours: 24,
    cancellationRefundType: CancellationRefundType.FULL,
    cancellationRefundPercentage: null,
    ...over,
  });

  it('en término y política completa: se devuelve todo', () => {
    expect(resolveRefund(politica(), conSeña, AHORA)).toMatchObject({
      type: CancellationRefundType.FULL,
      amountCents: 500_000,
      withinPolicy: true,
    });
  });

  it('sobre la hora: no se devuelve nada', () => {
    const unaHoraAntes = new Date('2026-09-10T13:00:00.000Z');

    expect(resolveRefund(politica(), conSeña, unaHoraAntes)).toMatchObject({
      type: CancellationRefundType.NONE,
      amountCents: 0,
      withinPolicy: false,
    });
  });

  /** El borde exacto cuenta como en término. */
  it('justo en el límite todavía entra', () => {
    const justo = new Date('2026-09-09T14:00:00.000Z'); // exactamente 24 h

    expect(resolveRefund(politica(), conSeña, justo)).toMatchObject({
      withinPolicy: true,
      type: CancellationRefundType.FULL,
    });
  });

  it('política parcial devuelve el porcentaje', () => {
    expect(
      resolveRefund(
        politica({
          cancellationRefundType: CancellationRefundType.PARTIAL,
          cancellationRefundPercentage: 50,
        }),
        conSeña,
        AHORA,
      ),
    ).toMatchObject({
      type: CancellationRefundType.PARTIAL,
      amountCents: 250_000,
    });
  });

  it('redondea al centavo', () => {
    expect(
      resolveRefund(
        politica({
          cancellationRefundType: CancellationRefundType.PARTIAL,
          cancellationRefundPercentage: 33,
        }),
        { ...conSeña, depositAmountCents: 10_001 },
        AHORA,
      ).amountCents,
    ).toBe(3300);
  });

  it('política de crédito no devuelve plata pero deja el monto a favor', () => {
    expect(
      resolveRefund(
        politica({ cancellationRefundType: CancellationRefundType.CREDIT }),
        conSeña,
        AHORA,
      ),
    ).toMatchObject({
      type: CancellationRefundType.CREDIT,
      amountCents: 500_000,
    });
  });

  it('política sin devolución no devuelve ni cancelando con tiempo', () => {
    expect(
      resolveRefund(
        politica({ cancellationRefundType: CancellationRefundType.NONE }),
        conSeña,
        AHORA,
      ),
    ).toMatchObject({ type: CancellationRefundType.NONE, amountCents: 0 });
  });

  describe('sin plata de por medio', () => {
    it('un turno sin seña no genera devolución', () => {
      expect(
        resolveRefund(
          politica(),
          {
            startsAt: EN_DOS_DIAS,
            depositAmountCents: null,
            depositPaid: false,
          },
          AHORA,
        ),
      ).toMatchObject({ type: CancellationRefundType.NONE, amountCents: 0 });
    });

    /** Pidió seña pero nunca la pagó: no hay nada que devolver. */
    it('una seña impaga tampoco', () => {
      expect(
        resolveRefund(politica(), { ...conSeña, depositPaid: false }, AHORA),
      ).toMatchObject({ amountCents: 0 });
    });

    it('pero igual informa si canceló en término', () => {
      expect(
        resolveRefund(politica(), { ...conSeña, depositPaid: false }, AHORA)
          .withinPolicy,
      ).toBe(true);
    });
  });
});
