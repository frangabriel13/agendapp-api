import {
  timeColumnToMinutes,
  zonedDayOfWeek,
  zonedMinutesOfDay,
  zonedWallTimeToUtc,
} from './timezone.util';

const BUENOS_AIRES = 'America/Argentina/Buenos_Aires';
const MADRID = 'Europe/Madrid';
const NEW_YORK = 'America/New_York';

const at = (hours: number, minutes = 0): number => hours * 60 + minutes;

describe('zonedWallTimeToUtc', () => {
  it('convierte una hora de Buenos Aires a UTC (UTC-3, sin horario de verano)', () => {
    expect(
      zonedWallTimeToUtc('2026-09-01', at(9), BUENOS_AIRES).toISOString(),
    ).toBe('2026-09-01T12:00:00.000Z');
  });

  it('la medianoche local cae en el día siguiente en UTC', () => {
    expect(
      zonedWallTimeToUtc('2026-01-15', at(0), BUENOS_AIRES).toISOString(),
    ).toBe('2026-01-15T03:00:00.000Z');
  });

  /**
   * El caso que hace que esto no pueda ser una resta fija. En Madrid el
   * horario de verano arranca el 29/3/2026: la misma hora de pared cae en dos
   * instantes distintos según el día.
   */
  it('usa el offset del día, no uno fijo (Madrid cruzando el cambio de hora)', () => {
    expect(zonedWallTimeToUtc('2026-03-28', at(9), MADRID).toISOString()).toBe(
      '2026-03-28T08:00:00.000Z', // CET, UTC+1
    );
    expect(zonedWallTimeToUtc('2026-03-29', at(9), MADRID).toISOString()).toBe(
      '2026-03-29T07:00:00.000Z', // CEST, UTC+2
    );
  });

  it('lo mismo del otro lado del Atlántico', () => {
    expect(
      zonedWallTimeToUtc('2026-03-08', at(9), NEW_YORK).toISOString(),
    ).toBe('2026-03-08T13:00:00.000Z');
    expect(
      zonedWallTimeToUtc('2026-07-04', at(9), NEW_YORK).toISOString(),
    ).toBe('2026-07-04T13:00:00.000Z');
  });

  /**
   * Los dos casos raros del cambio de hora. No hay respuesta "correcta": lo que
   * importa es que devuelvan un instante real y siempre el mismo, en vez de
   * `Invalid Date` o algo que se corra un día.
   */
  describe('bordes del cambio de hora', () => {
    it('una hora que no existe se resuelve después del salto', () => {
      // El 29/3/2026 Madrid salta de 02:00 a 03:00: las 02:30 no ocurren.
      expect(
        zonedWallTimeToUtc('2026-03-29', at(2, 30), MADRID).toISOString(),
      ).toBe('2026-03-29T01:30:00.000Z');
    });

    it('una hora repetida elige siempre la misma de las dos', () => {
      // El 25/10/2026 Madrid vuelve de 03:00 a 02:00: las 02:30 ocurren dos veces.
      expect(
        zonedWallTimeToUtc('2026-10-25', at(2, 30), MADRID).toISOString(),
      ).toBe('2026-10-25T01:30:00.000Z');
    });
  });

  it('aguanta una zona del otro lado de la línea de fecha', () => {
    // Kiritimati es UTC+14: su medianoche es la mañana del día anterior en UTC.
    expect(
      zonedWallTimeToUtc(
        '2026-09-01',
        at(0),
        'Pacific/Kiritimati',
      ).toISOString(),
    ).toBe('2026-08-31T10:00:00.000Z');
  });

  /**
   * El bug que este módulo existe para evitar: que el resultado dependa de
   * dónde corra el proceso. En producción es UTC, en la máquina de alguien no.
   */
  it('no depende de la zona horaria del proceso', () => {
    const original = process.env.TZ;

    try {
      process.env.TZ = 'Asia/Tokyo';
      const tokio = zonedWallTimeToUtc('2026-09-01', at(9), BUENOS_AIRES);

      process.env.TZ = 'America/New_York';
      const nuevaYork = zonedWallTimeToUtc('2026-09-01', at(9), BUENOS_AIRES);

      expect(tokio.toISOString()).toBe(nuevaYork.toISOString());
    } finally {
      process.env.TZ = original;
    }
  });
});

describe('zonedDayOfWeek', () => {
  it('devuelve 0 para domingo y 6 para sábado', () => {
    expect(zonedDayOfWeek('2026-08-16', BUENOS_AIRES)).toBe(0);
    expect(zonedDayOfWeek('2026-08-17', BUENOS_AIRES)).toBe(1);
    expect(zonedDayOfWeek('2026-08-22', BUENOS_AIRES)).toBe(6);
  });

  it('mira el día en la zona del negocio, no en UTC', () => {
    // Kiritimati (UTC+14) ya está en martes cuando en UTC todavía es lunes.
    expect(zonedDayOfWeek('2026-09-01', 'Pacific/Kiritimati')).toBe(2);
  });

  it('rechaza una zona que no existe', () => {
    expect(() => zonedDayOfWeek('2026-09-01', 'Marte/Olympus')).toThrow();
  });
});

describe('timeColumnToMinutes', () => {
  /** Prisma devuelve los `TIME` anclados al 1970-01-01 en UTC. */
  it('lee la hora de pared de una columna TIME', () => {
    expect(timeColumnToMinutes(new Date('1970-01-01T09:30:00.000Z'))).toBe(570);
    expect(timeColumnToMinutes(new Date('1970-01-01T00:00:00.000Z'))).toBe(0);
    expect(timeColumnToMinutes(new Date('1970-01-01T23:59:00.000Z'))).toBe(
      1439,
    );
  });
});

describe('zonedMinutesOfDay', () => {
  it('devuelve la hora de pared del negocio, no la de UTC', () => {
    const instante = new Date('2026-09-01T12:00:00.000Z');

    expect(zonedMinutesOfDay(instante, BUENOS_AIRES)).toBe(9 * 60);
    expect(zonedMinutesOfDay(instante, 'UTC')).toBe(12 * 60);
  });

  /** Ida y vuelta: lo que entra por `zonedWallTimeToUtc` tiene que volver igual. */
  it('es el inverso de zonedWallTimeToUtc', () => {
    const instante = zonedWallTimeToUtc('2026-09-01', 10 * 60 + 30, MADRID);

    expect(zonedMinutesOfDay(instante, MADRID)).toBe(10 * 60 + 30);
  });
});
