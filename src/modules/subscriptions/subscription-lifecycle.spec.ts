import { SubscriptionStatus } from '@prisma/client';
import {
  addMonthsUtc,
  blocksNewBookings,
  daysOverdue,
  hasLapsed,
  nextPeriod,
} from './subscription-lifecycle';

const { TRIAL, ACTIVE, PAST_DUE, CANCELED, PAUSED } = SubscriptionStatus;

const at = (iso: string): Date => new Date(iso);
const GRACE = 7;

describe('addMonthsUtc', () => {
  it('mismo día del mes siguiente', () => {
    expect(addMonthsUtc(at('2026-08-15T10:30:00Z'), 1).toISOString()).toBe(
      '2026-09-15T10:30:00.000Z',
    );
  });

  it('conserva la hora', () => {
    expect(addMonthsUtc(at('2026-08-15T23:59:59Z'), 1).toISOString()).toBe(
      '2026-09-15T23:59:59.000Z',
    );
  });

  it('cruza el fin de año', () => {
    expect(addMonthsUtc(at('2026-12-20T00:00:00Z'), 1).toISOString()).toBe(
      '2027-01-20T00:00:00.000Z',
    );
  });

  /** El 31 de enero más un mes no es el 3 de marzo. */
  it('recorta al último día del mes', () => {
    expect(addMonthsUtc(at('2027-01-31T12:00:00Z'), 1).toISOString()).toBe(
      '2027-02-28T12:00:00.000Z',
    );
  });

  it('en año bisiesto febrero llega al 29', () => {
    expect(addMonthsUtc(at('2028-01-31T12:00:00Z'), 1).toISOString()).toBe(
      '2028-02-29T12:00:00.000Z',
    );
  });

  it('el 31 sobrevive a un mes de 30', () => {
    expect(addMonthsUtc(at('2026-08-31T12:00:00Z'), 1).toISOString()).toBe(
      '2026-09-30T12:00:00.000Z',
    );
  });
});

describe('daysOverdue', () => {
  it('cero mientras no venza', () => {
    expect(
      daysOverdue(at('2026-09-01T00:00:00Z'), at('2026-08-20T00:00:00Z')),
    ).toBe(0);
  });

  it('cero el mismo instante del vencimiento', () => {
    expect(
      daysOverdue(at('2026-08-20T00:00:00Z'), at('2026-08-20T00:00:00Z')),
    ).toBe(0);
  });

  /** Días completos: unas horas de atraso todavía no es un día. */
  it('cuenta días completos', () => {
    expect(
      daysOverdue(at('2026-08-20T00:00:00Z'), at('2026-08-20T23:00:00Z')),
    ).toBe(0);
    expect(
      daysOverdue(at('2026-08-20T00:00:00Z'), at('2026-08-23T06:00:00Z')),
    ).toBe(3);
  });
});

describe('hasLapsed', () => {
  const AYER = at('2026-08-19T00:00:00Z');
  const HOY = at('2026-08-20T00:00:00Z');
  const MAÑANA = at('2026-08-21T00:00:00Z');

  it('una prueba que se terminó vence igual que un mes impago', () => {
    expect(hasLapsed({ status: TRIAL, currentPeriodEnd: AYER }, HOY)).toBe(
      true,
    );
    expect(hasLapsed({ status: ACTIVE, currentPeriodEnd: AYER }, HOY)).toBe(
      true,
    );
  });

  it('no vence antes de tiempo', () => {
    expect(hasLapsed({ status: ACTIVE, currentPeriodEnd: MAÑANA }, HOY)).toBe(
      false,
    );
  });

  /** Idempotencia del cron: correrlo dos veces no tiene nada que hacer. */
  it('una que ya está vencida no se vuelve a vencer', () => {
    expect(hasLapsed({ status: PAST_DUE, currentPeriodEnd: AYER }, HOY)).toBe(
      false,
    );
  });

  it('no toca las que están fuera del ciclo normal', () => {
    expect(hasLapsed({ status: CANCELED, currentPeriodEnd: AYER }, HOY)).toBe(
      false,
    );
    expect(hasLapsed({ status: PAUSED, currentPeriodEnd: AYER }, HOY)).toBe(
      false,
    );
  });
});

describe('blocksNewBookings', () => {
  const VENCIO = at('2026-08-01T00:00:00Z');

  it('estar al día no bloquea', () => {
    expect(
      blocksNewBookings(
        { status: ACTIVE, currentPeriodEnd: at('2026-09-01T00:00:00Z') },
        at('2026-08-20T00:00:00Z'),
        GRACE,
      ),
    ).toBe(false);
  });

  it('una prueba viva no bloquea', () => {
    expect(
      blocksNewBookings(
        { status: TRIAL, currentPeriodEnd: at('2026-09-01T00:00:00Z') },
        at('2026-08-20T00:00:00Z'),
        GRACE,
      ),
    ).toBe(false);
  });

  /**
   * Lo importante de la ventana de gracia: una tarjeta que rebota se arregla en
   * un día, y dejar a un negocio sin agenda por eso es desproporcionado.
   */
  it('deber poco no bloquea', () => {
    expect(
      blocksNewBookings(
        { status: PAST_DUE, currentPeriodEnd: VENCIO },
        at('2026-08-05T00:00:00Z'),
        GRACE,
      ),
    ).toBe(false);
  });

  it('el último día de gracia todavía no bloquea', () => {
    expect(
      blocksNewBookings(
        { status: PAST_DUE, currentPeriodEnd: VENCIO },
        at('2026-08-08T00:00:00Z'),
        GRACE,
      ),
    ).toBe(false);
  });

  it('pasada la gracia sí', () => {
    expect(
      blocksNewBookings(
        { status: PAST_DUE, currentPeriodEnd: VENCIO },
        at('2026-08-09T00:00:00Z'),
        GRACE,
      ),
    ).toBe(true);
  });

  it('una suscripción cancelada bloquea siempre', () => {
    expect(
      blocksNewBookings(
        { status: CANCELED, currentPeriodEnd: at('2099-01-01T00:00:00Z') },
        at('2026-08-20T00:00:00Z'),
        GRACE,
      ),
    ).toBe(true);
  });

  it('sin gracia, deber un día ya bloquea', () => {
    expect(
      blocksNewBookings(
        { status: PAST_DUE, currentPeriodEnd: VENCIO },
        at('2026-08-02T00:00:00Z'),
        0,
      ),
    ).toBe(true);
  });
});

describe('nextPeriod', () => {
  const VENCE = at('2026-09-01T00:00:00Z');

  it('pagar antes de vencer sigue de largo', () => {
    expect(nextPeriod(VENCE, at('2026-08-28T00:00:00Z'), GRACE)).toEqual({
      start: VENCE,
      end: at('2026-10-01T00:00:00Z'),
    });
  });

  /**
   * Estuvo usando el servicio esos días (por eso existe la gracia), así que
   * corresponde que los pague: el período nuevo arranca donde terminó el viejo.
   */
  it('pagar dentro de la gracia no regala los días usados', () => {
    expect(nextPeriod(VENCE, at('2026-09-04T00:00:00Z'), GRACE)).toEqual({
      start: VENCE,
      end: at('2026-10-01T00:00:00Z'),
    });
  });

  /** Cobrarle meses en los que estuvo bloqueado sería cobrarle por nada. */
  it('volver mucho después arranca hoy', () => {
    const ahora = at('2026-11-15T10:00:00Z');

    expect(nextPeriod(VENCE, ahora, GRACE)).toEqual({
      start: ahora,
      end: at('2026-12-15T10:00:00Z'),
    });
  });
});
