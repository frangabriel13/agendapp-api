import { RecurrenceFrequency } from '@prisma/client';

/**
 * Las fechas de una serie de turnos repetidos.
 *
 * Todo acá es **calendario puro**: se trabaja con `"YYYY-MM-DD"`, sin horas ni
 * zonas. Es a propósito. "Todos los lunes a las 10" significa las 10 de la
 * mañana del negocio, no "cada 168 horas": si la serie cruza un cambio de hora
 * y se sumaran milisegundos, a partir de ahí los turnos caerían a las 9 o a las
 * 11. La hora se vuelve a pegar después, convirtiendo cada fecha con la zona
 * del negocio (`zonedWallTimeToUtc`).
 */

/** El día calendario como número, para poder sumarle días sin sorpresas. */
function toUtcMillis(dateOnly: string): number {
  const [year, month, day] = dateOnly.split('-').map(Number);

  return Date.UTC(year, month - 1, day);
}

function toDateOnly(millis: number): string {
  return new Date(millis).toISOString().slice(0, 10);
}

/** Cuántos días tiene ese mes. El día 0 del siguiente es el último de este. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

/**
 * Suma meses respetando el día, y lo **recorta** cuando ese día no existe: el
 * 31 de enero más un mes es el 28 (o 29) de febrero, no el 3 de marzo.
 *
 * Recortar en vez de desbordar mantiene la serie anclada al final del mes, que
 * es lo que espera quien reserva "el 31 de cada mes".
 */
function addMonths(dateOnly: string, months: number): string {
  const [year, month, day] = dateOnly.split('-').map(Number);

  const targetMonth = month - 1 + months;
  const targetYear = year + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;

  const clamped = Math.min(day, daysInMonth(targetYear, normalizedMonth));

  return toDateOnly(Date.UTC(targetYear, normalizedMonth, clamped));
}

const DAYS_BETWEEN: Readonly<Record<RecurrenceFrequency, number>> = {
  [RecurrenceFrequency.WEEKLY]: 7,
  [RecurrenceFrequency.BIWEEKLY]: 14,
  [RecurrenceFrequency.MONTHLY]: 0, // los meses no son un número fijo de días
};

/**
 * `("2026-09-07", WEEKLY, 4)` → los cuatro lunes seguidos.
 *
 * La primera fecha de la serie es siempre la que se pasó: quien reserva "todos
 * los lunes empezando el 7" espera que el 7 esté incluido.
 */
export function recurrenceDates(
  from: string,
  frequency: RecurrenceFrequency,
  occurrences: number,
): string[] {
  if (occurrences <= 0) {
    throw new RangeError('Una serie tiene que tener al menos un turno');
  }

  if (frequency === RecurrenceFrequency.MONTHLY) {
    return Array.from({ length: occurrences }, (_, index) =>
      addMonths(from, index),
    );
  }

  const step = DAYS_BETWEEN[frequency] * 86_400_000;
  const start = toUtcMillis(from);

  return Array.from({ length: occurrences }, (_, index) =>
    toDateOnly(start + index * step),
  );
}
