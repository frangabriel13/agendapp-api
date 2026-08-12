/**
 * Traducción entre la hora de pared que viaja por la API (`"09:30"`) y el tipo
 * `TIME` de Postgres.
 *
 * Un horario de atención NO es un instante: "abre 09:00" no depende del día ni
 * de la zona horaria, a diferencia de un turno, que sí es un momento puntual y
 * se guarda en `TIMESTAMPTZ`. Por eso las columnas son `TIME` y la zona del
 * negocio vive una sola vez en `Tenant.timezone`.
 *
 * Prisma no tiene un tipo "hora suelta": una columna `TIME` va y viene como
 * `Date` anclada al 1970-01-01 en UTC (`1970-01-01T09:30:00.000Z`), con la
 * hora intacta. Verificado contra Postgres con el driver adapter. Serializar
 * ese `Date` a JSON escupiría la fecha de mentira, así que la API nunca lo
 * expone: entra y sale como `"HH:MM"`.
 */

/** `"09:30"`, de `00:00` a `23:59`. */
export const TIME_OF_DAY_PATTERN = '^([01][0-9]|2[0-3]):[0-5][0-9]$';

export const TIME_OF_DAY_REGEX = new RegExp(TIME_OF_DAY_PATTERN);

/** Día ancla de las columnas `TIME`. Nunca se muestra: solo sostiene la hora. */
const EPOCH_DAY = '1970-01-01';

/** `"09:30"` → `Date(1970-01-01T09:30:00Z)`, listo para guardar. */
export function timeOfDayToDate(value: string): Date {
  if (!TIME_OF_DAY_REGEX.test(value)) {
    throw new RangeError(`"${value}" no es una hora válida (formato HH:MM)`);
  }

  return new Date(`${EPOCH_DAY}T${value}:00.000Z`);
}

/** `Date(1970-01-01T09:30:00Z)` → `"09:30"`, listo para responder. */
export function dateToTimeOfDay(value: Date): string {
  return value.toISOString().slice(11, 16);
}

/** Igual que `dateToTimeOfDay` pero deja pasar el null de los días cerrados. */
export function dateToTimeOfDayOrNull(value: Date | null): string | null {
  return value === null ? null : dateToTimeOfDay(value);
}

/** Minutos desde medianoche. Ordena y compara horas sin tocar `Date`. */
export function timeOfDayToMinutes(value: string): number {
  const [hours, minutes] = value.split(':');
  return Number(hours) * 60 + Number(minutes);
}
