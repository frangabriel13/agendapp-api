import { AppointmentStatus } from '@prisma/client';

/**
 * Aritmética de intervalos: el núcleo del cálculo de disponibilidad.
 *
 * Todo acá es función pura sobre instantes ya convertidos a UTC. La conversión
 * desde hora de pared vive en `src/common/utils/timezone.util.ts` y pasa
 * **antes** de entrar acá — así el horario de verano queda resuelto de entrada y
 * este archivo no tiene que saber nada de zonas horarias.
 *
 * La disponibilidad de alguien es, literalmente:
 *
 * ```
 * (horario de la sucursal ∩ horario del empleado)
 *   − ausencias − turnos que ya tiene − recursos ocupados
 * ```
 *
 * y después se corta en slots. Cada paso es una de las funciones de abajo.
 */

/** Un rango de tiempo semiabierto: incluye `start`, excluye `end`. */
export interface Interval {
  start: Date;
  end: Date;
}

/**
 * Los estados que **liberan** la agenda: un turno cancelado o reprogramado deja
 * de ocupar a su profesional.
 *
 * ⚠️ Esta lista tiene que decir lo mismo que el `WHERE` de los EXCLUDE
 * constraints en la migración `20260819175745_appointments`. Si se agrega un
 * estado, van los dos lados: si solo se toca acá, la disponibilidad lo ignora
 * pero la base lo sigue bloqueando (y sale un 409 inexplicable); si solo se
 * toca la migración, pasa al revés.
 */
export const NON_BLOCKING_STATUSES: readonly AppointmentStatus[] = [
  AppointmentStatus.CANCELED_BY_CUSTOMER,
  AppointmentStatus.CANCELED_BY_BUSINESS,
  AppointmentStatus.RESCHEDULED,
];

/** Los que sí ocupan. Se deriva de la anterior para que no puedan divergir. */
export const BLOCKING_STATUSES: readonly AppointmentStatus[] = Object.values(
  AppointmentStatus,
).filter((status) => !NON_BLOCKING_STATUSES.includes(status));

/**
 * Ordena, descarta los vacíos y funde los que se tocan o se pisan.
 *
 * Fundir los que se tocan (uno termina justo donde arranca el otro) no es un
 * detalle estético: si quedaran separados, restarlos dejaría un hueco de cero
 * minutos que después se cuela como slot imposible.
 */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const sorted = intervals
    .filter((interval) => interval.end.getTime() > interval.start.getTime())
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const merged: Interval[] = [];

  for (const interval of sorted) {
    const last = merged[merged.length - 1];

    if (last && interval.start.getTime() <= last.end.getTime()) {
      if (interval.end.getTime() > last.end.getTime()) {
        last.end = interval.end;
      }
      continue;
    }

    merged.push({ start: interval.start, end: interval.end });
  }

  return merged;
}

/**
 * Lo que está en `a` **y** en `b`. Se usa para cruzar el horario del negocio con
 * el del empleado: alguien puede tener turno de 8 a 20 pero si el local abre a
 * las 10, antes no atiende.
 */
export function intersectIntervals(a: Interval[], b: Interval[]): Interval[] {
  const left = mergeIntervals(a);
  const right = mergeIntervals(b);
  const result: Interval[] = [];

  let i = 0;
  let j = 0;

  while (i < left.length && j < right.length) {
    const start = Math.max(left[i].start.getTime(), right[j].start.getTime());
    const end = Math.min(left[i].end.getTime(), right[j].end.getTime());

    if (start < end) {
      result.push({ start: new Date(start), end: new Date(end) });
    }

    // Avanza el que termina antes: el otro todavía puede cruzarse con el que sigue.
    if (left[i].end.getTime() < right[j].end.getTime()) {
      i += 1;
    } else {
      j += 1;
    }
  }

  return result;
}

/**
 * Lo que queda de `base` después de sacarle `blockers`. Un bloqueo que cae en el
 * medio parte el intervalo en dos — es lo que pasa con un turno a las 14 en una
 * jornada de 9 a 18.
 */
export function subtractIntervals(
  base: Interval[],
  blockers: Interval[],
): Interval[] {
  let remaining = mergeIntervals(base);

  for (const blocker of mergeIntervals(blockers)) {
    const next: Interval[] = [];

    for (const segment of remaining) {
      const noOverlap =
        blocker.end.getTime() <= segment.start.getTime() ||
        blocker.start.getTime() >= segment.end.getTime();

      if (noOverlap) {
        next.push(segment);
        continue;
      }

      if (blocker.start.getTime() > segment.start.getTime()) {
        next.push({ start: segment.start, end: blocker.start });
      }

      if (blocker.end.getTime() < segment.end.getTime()) {
        next.push({ start: blocker.end, end: segment.end });
      }
    }

    remaining = next;
  }

  return remaining;
}

/**
 * Corta los ratos libres en turnos concretos.
 *
 * `slotMinutes` es **duración + buffer**: el buffer es tiempo en el que el
 * profesional sigue ocupado (ordenar, limpiar), así que forma parte de lo que
 * el turno reserva. Por eso el último turno del día termina `buffer` minutos
 * antes del cierre y no justo al cierre — es a propósito.
 *
 * `stepMinutes` es cada cuánto arranca un turno. Por defecto van pegados, que
 * es lo que pide el roadmap y lo que aprovecha mejor el día. Si algún día se
 * quiere una grilla más fina (que se pueda reservar a y cuarto aunque el
 * servicio dure 45 minutos), se cambia solo este parámetro.
 */
export function splitIntoSlots(
  free: Interval[],
  slotMinutes: number,
  stepMinutes: number = slotMinutes,
): Interval[] {
  if (slotMinutes <= 0 || stepMinutes <= 0) {
    throw new RangeError('La duración y el paso de un slot tienen que ser > 0');
  }

  const slotMs = slotMinutes * 60_000;
  const stepMs = stepMinutes * 60_000;
  const slots: Interval[] = [];

  for (const window of mergeIntervals(free)) {
    const limit = window.end.getTime();

    for (
      let start = window.start.getTime();
      start + slotMs <= limit;
      start += stepMs
    ) {
      slots.push({ start: new Date(start), end: new Date(start + slotMs) });
    }
  }

  return slots;
}

/** `true` si los dos rangos comparten aunque sea un instante. */
export function overlaps(a: Interval, b: Interval): boolean {
  return (
    a.start.getTime() < b.end.getTime() && b.start.getTime() < a.end.getTime()
  );
}
