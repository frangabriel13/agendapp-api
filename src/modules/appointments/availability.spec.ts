import { AppointmentStatus } from '@prisma/client';
import {
  BLOCKING_STATUSES,
  NON_BLOCKING_STATUSES,
  intersectIntervals,
  mergeIntervals,
  overlaps,
  splitIntoSlots,
  subtractIntervals,
  type Interval,
} from './availability';

/** `iv('09:00', '18:00')` — todo el día 2026-09-01, para no repetir la fecha. */
const iv = (from: string, to: string): Interval => ({
  start: new Date(`2026-09-01T${from}:00.000Z`),
  end: new Date(`2026-09-01T${to}:00.000Z`),
});

/** Los intervalos como `"09:00-18:00"`, que es lo que se puede leer de un vistazo. */
const show = (intervals: Interval[]): string[] =>
  intervals.map(
    (interval) =>
      `${interval.start.toISOString().slice(11, 16)}-${interval.end
        .toISOString()
        .slice(11, 16)}`,
  );

describe('estados que bloquean', () => {
  it('cancelados y reprogramados liberan la agenda', () => {
    expect(NON_BLOCKING_STATUSES).toEqual([
      AppointmentStatus.CANCELED_BY_CUSTOMER,
      AppointmentStatus.CANCELED_BY_BUSINESS,
      AppointmentStatus.RESCHEDULED,
    ]);
  });

  /** Un `no_show` pasó igual: esa hora estuvo ocupada. */
  it('todos los demás ocupan, incluido no_show', () => {
    expect(BLOCKING_STATUSES).toEqual([
      AppointmentStatus.PENDING_PAYMENT,
      AppointmentStatus.CONFIRMED,
      AppointmentStatus.ATTENDED,
      AppointmentStatus.NO_SHOW,
    ]);
  });

  it('entre las dos listas está el enum completo', () => {
    expect([...BLOCKING_STATUSES, ...NON_BLOCKING_STATUSES].sort()).toEqual(
      Object.values(AppointmentStatus).sort(),
    );
  });
});

describe('mergeIntervals', () => {
  it('ordena y funde los que se pisan', () => {
    expect(
      show(mergeIntervals([iv('14:00', '16:00'), iv('09:00', '15:00')])),
    ).toEqual(['09:00-16:00']);
  });

  /** Si quedaran separados, restarlos dejaría un hueco de cero minutos. */
  it('funde también los que apenas se tocan', () => {
    expect(
      show(mergeIntervals([iv('09:00', '12:00'), iv('12:00', '18:00')])),
    ).toEqual(['09:00-18:00']);
  });

  it('deja en paz los que no se tocan', () => {
    expect(
      show(mergeIntervals([iv('09:00', '12:00'), iv('13:00', '18:00')])),
    ).toEqual(['09:00-12:00', '13:00-18:00']);
  });

  it('descarta los vacíos y los invertidos', () => {
    expect(
      mergeIntervals([iv('12:00', '12:00'), iv('15:00', '14:00')]),
    ).toEqual([]);
  });

  it('no toca el array que recibe', () => {
    const original = [iv('14:00', '16:00'), iv('09:00', '12:00')];
    mergeIntervals(original);

    expect(show(original)).toEqual(['14:00-16:00', '09:00-12:00']);
  });
});

describe('intersectIntervals', () => {
  it('el empleado solo atiende mientras el local está abierto', () => {
    const local = [iv('10:00', '19:00')];
    const empleado = [iv('08:00', '20:00')];

    expect(show(intersectIntervals(local, empleado))).toEqual(['10:00-19:00']);
  });

  it('un turno partido cruzado con el horario del local da dos tramos', () => {
    const local = [iv('09:00', '18:00')];
    const empleado = [iv('08:00', '12:00'), iv('16:00', '20:00')];

    expect(show(intersectIntervals(local, empleado))).toEqual([
      '09:00-12:00',
      '16:00-18:00',
    ]);
  });

  it('sin superposición no queda nada', () => {
    expect(
      intersectIntervals([iv('09:00', '12:00')], [iv('14:00', '18:00')]),
    ).toEqual([]);
  });

  it('tocarse no es superponerse', () => {
    expect(
      intersectIntervals([iv('09:00', '12:00')], [iv('12:00', '18:00')]),
    ).toEqual([]);
  });

  it('si el empleado no tiene horario cargado, no hay disponibilidad', () => {
    expect(intersectIntervals([iv('09:00', '18:00')], [])).toEqual([]);
  });
});

describe('subtractIntervals', () => {
  it('un turno en el medio parte la jornada en dos', () => {
    expect(
      show(subtractIntervals([iv('09:00', '18:00')], [iv('14:00', '15:00')])),
    ).toEqual(['09:00-14:00', '15:00-18:00']);
  });

  it('un bloqueo al principio corre el arranque', () => {
    expect(
      show(subtractIntervals([iv('09:00', '18:00')], [iv('08:00', '11:00')])),
    ).toEqual(['11:00-18:00']);
  });

  it('un bloqueo que cubre todo no deja nada', () => {
    expect(
      subtractIntervals([iv('09:00', '18:00')], [iv('00:00', '23:00')]),
    ).toEqual([]);
  });

  it('varios bloqueos se sacan todos', () => {
    const libre = subtractIntervals(
      [iv('09:00', '18:00')],
      [iv('10:00', '11:00'), iv('13:00', '14:00'), iv('16:30', '17:00')],
    );

    expect(show(libre)).toEqual([
      '09:00-10:00',
      '11:00-13:00',
      '14:00-16:30',
      '17:00-18:00',
    ]);
  });

  it('bloqueos que se pisan entre sí cuentan una sola vez', () => {
    expect(
      show(
        subtractIntervals(
          [iv('09:00', '18:00')],
          [iv('12:00', '15:00'), iv('13:00', '16:00')],
        ),
      ),
    ).toEqual(['09:00-12:00', '16:00-18:00']);
  });

  it('un bloqueo que no toca nada no cambia nada', () => {
    expect(
      show(subtractIntervals([iv('09:00', '12:00')], [iv('14:00', '15:00')])),
    ).toEqual(['09:00-12:00']);
  });

  it('resta sobre un turno partido', () => {
    const jornada = [iv('09:00', '12:00'), iv('16:00', '20:00')];

    expect(show(subtractIntervals(jornada, [iv('10:00', '17:00')]))).toEqual([
      '09:00-10:00',
      '17:00-20:00',
    ]);
  });
});

describe('splitIntoSlots', () => {
  it('corta la jornada en turnos pegados', () => {
    expect(show(splitIntoSlots([iv('09:00', '12:00')], 60))).toEqual([
      '09:00-10:00',
      '10:00-11:00',
      '11:00-12:00',
    ]);
  });

  /**
   * Lo que sobra al final se descarta: un turno de 45 minutos no entra en 30.
   */
  it('descarta el resto que no alcanza para un turno entero', () => {
    expect(show(splitIntoSlots([iv('09:00', '10:40')], 45))).toEqual([
      '09:00-09:45',
      '09:45-10:30',
    ]);
  });

  /**
   * El buffer va adentro del slot porque el profesional sigue ocupado. La
   * consecuencia visible es que el último turno no llega hasta el cierre.
   */
  it('el buffer entra en el slot, así que el último termina antes del cierre', () => {
    const slots = splitIntoSlots([iv('09:00', '11:00')], 45 + 15);

    expect(show(slots)).toEqual(['09:00-10:00', '10:00-11:00']);
  });

  it('con paso más chico que el slot, los turnos se superponen en la grilla', () => {
    expect(show(splitIntoSlots([iv('09:00', '10:00')], 45, 15))).toEqual([
      '09:00-09:45',
      '09:15-10:00',
    ]);
  });

  it('cada tramo libre arranca su propia grilla', () => {
    const slots = splitIntoSlots(
      [iv('09:00', '10:00'), iv('14:30', '15:30')],
      30,
    );

    expect(show(slots)).toEqual([
      '09:00-09:30',
      '09:30-10:00',
      '14:30-15:00',
      '15:00-15:30',
    ]);
  });

  it('un hueco más chico que un turno no genera nada', () => {
    expect(splitIntoSlots([iv('09:00', '09:20')], 30)).toEqual([]);
  });

  it('sin tiempo libre no hay turnos', () => {
    expect(splitIntoSlots([], 30)).toEqual([]);
  });

  it('rechaza una duración de cero o negativa', () => {
    expect(() => splitIntoSlots([iv('09:00', '18:00')], 0)).toThrow(RangeError);
    expect(() => splitIntoSlots([iv('09:00', '18:00')], 30, -5)).toThrow(
      RangeError,
    );
  });
});

describe('overlaps', () => {
  it('dos rangos que comparten tiempo se pisan', () => {
    expect(overlaps(iv('09:00', '11:00'), iv('10:00', '12:00'))).toBe(true);
  });

  /** Los rangos son semiabiertos: 09-10 y 10-11 son turnos consecutivos. */
  it('tocarse no es pisarse', () => {
    expect(overlaps(iv('09:00', '10:00'), iv('10:00', '11:00'))).toBe(false);
  });

  it('uno adentro del otro se pisa', () => {
    expect(overlaps(iv('09:00', '18:00'), iv('13:00', '14:00'))).toBe(true);
  });
});

/**
 * El día que el reloj cambia, la misma jornada de pared dura una hora más o una
 * hora menos. Como acá ya se trabaja con instantes, sale solo — pero conviene
 * dejarlo fijado, porque es el caso que el roadmap marca como obligatorio.
 */
describe('días con cambio de hora', () => {
  it('una jornada de 23 horas reales genera menos turnos', () => {
    // Madrid, 29/3/2026: de 00:00 a 06:00 de pared hay solo 5 horas reales.
    const jornada: Interval[] = [
      {
        start: new Date('2026-03-28T23:00:00.000Z'), // 00:00 local (CET)
        end: new Date('2026-03-29T04:00:00.000Z'), // 06:00 local (CEST)
      },
    ];

    expect(splitIntoSlots(jornada, 60)).toHaveLength(5);
  });

  it('una jornada de 25 horas reales genera más', () => {
    // Madrid, 25/10/2026: de 00:00 a 06:00 de pared hay 7 horas reales.
    const jornada: Interval[] = [
      {
        start: new Date('2026-10-24T22:00:00.000Z'), // 00:00 local (CEST)
        end: new Date('2026-10-25T05:00:00.000Z'), // 06:00 local (CET)
      },
    ];

    expect(splitIntoSlots(jornada, 60)).toHaveLength(7);
  });
});
