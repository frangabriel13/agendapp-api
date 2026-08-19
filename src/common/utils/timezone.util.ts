/**
 * Traducción entre la hora que ve el negocio y el instante que guarda la base.
 *
 * El problema que resuelve: el horario de atención es hora de pared ("abrimos a
 * las 9") y los turnos son instantes (`TIMESTAMPTZ`). Para saber si un turno
 * cae dentro del horario hay que llevar las dos cosas al mismo terreno, y eso
 * depende de la zona del negocio (`Tenant.timezone`), no de la del servidor.
 *
 * **Nunca usar `getHours()`, `setHours()` ni `new Date(y, m, d)`.** Todos esos
 * leen la zona del proceso, que en producción es UTC y en la máquina de alguien
 * es cualquier cosa: el mismo código daría resultados distintos según dónde
 * corra. Acá todo pasa por `Intl`, que sí sabe de zonas horarias y de horario
 * de verano.
 *
 * Argentina hoy no cambia la hora, pero `Tenant.timezone` es configurable y el
 * día que un negocio esté en una zona que sí lo hace, esto tiene que aguantar.
 */

/**
 * Un día entero en minutos. Las horas de pared se pasan como minutos desde la
 * medianoche (`9 * 60` son las 09:00), así que `MINUTES_PER_DAY` es la
 * medianoche del día siguiente.
 */
export const MINUTES_PER_DAY = 24 * 60;

/**
 * Cuántos minutos está adelantada la zona respecto de UTC en ese instante.
 *
 * El truco: se formatea el instante en la zona pedida y se vuelven a armar esos
 * números como si fueran UTC. La diferencia contra el instante original es el
 * offset. Es la única forma de preguntarle el offset a `Intl`, que no lo expone
 * directamente.
 */
function zoneOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23', // sin esto, la medianoche puede salir como "24"
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  const asIfUtc = Date.UTC(
    read('year'),
    read('month') - 1,
    read('day'),
    read('hour'),
    read('minute'),
    read('second'),
  );

  return (asIfUtc - instant.getTime()) / 60_000;
}

/**
 * `("2026-09-01", 9 * 60, "America/Argentina/Buenos_Aires")` → el instante en
 * que son las 09:00 de ese día en Buenos Aires.
 *
 * Va en dos pasadas porque el offset depende del instante y el instante depende
 * del offset. La primera usa el offset que rige en la hora "ingenua" (tratando
 * la hora de pared como si fuera UTC); la segunda lo recalcula ya parada en el
 * instante correcto. Con dos alcanza: el error de la primera es a lo sumo el
 * salto de horario de verano, y volver a preguntar desde ahí ya cae del lado
 * bueno.
 *
 * Los dos casos raros del cambio de hora tienen respuesta definida, no error:
 *
 * - **Hora que no existe** (la madrugada en que el reloj salta hacia adelante):
 *   devuelve el instante equivalente después del salto.
 * - **Hora repetida** (cuando el reloj atrasa y esa hora ocurre dos veces):
 *   devuelve una de las dos, consistentemente.
 *
 * Para un horario de atención eso alcanza: son dos días al año, y el resultado
 * siempre es un instante real dentro de la jornada.
 */
export function zonedWallTimeToUtc(
  dateOnly: string,
  minutesOfDay: number,
  timeZone: string,
): Date {
  const [year, month, day] = dateOnly.split('-').map(Number);
  const naive = Date.UTC(year, month - 1, day) + minutesOfDay * 60_000;

  const firstGuess =
    naive - zoneOffsetMinutes(new Date(naive), timeZone) * 60_000;
  const corrected =
    naive - zoneOffsetMinutes(new Date(firstGuess), timeZone) * 60_000;

  return new Date(corrected);
}

/**
 * Qué día de la semana es esa fecha en esa zona. `0` = domingo … `6` = sábado,
 * igual que `BranchBusinessHour.dayOfWeek` y que `Date.getDay()`.
 *
 * Se calcula parado en el mediodía local y no en la medianoche: la medianoche
 * es justo el borde que el cambio de hora puede correr, y un feriado que se
 * mueve un día sería un bug muy difícil de ver.
 */
export function zonedDayOfWeek(dateOnly: string, timeZone: string): number {
  const noon = zonedWallTimeToUtc(dateOnly, 12 * 60, timeZone);

  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
  }).format(noon);

  const index = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(
    weekday,
  );

  if (index === -1) {
    throw new RangeError(`Zona horaria desconocida: ${timeZone}`);
  }

  return index;
}

/**
 * Un `TIME` de Postgres a minutos desde la medianoche.
 *
 * Prisma devuelve las columnas `TIME` como `Date` ancladas al 1970-01-01 en
 * UTC, así que la hora se lee con métodos UTC. Es el mismo criterio que usa
 * `time-of-day.util.ts` para exponerlas como `"HH:MM"`.
 */
export function timeColumnToMinutes(value: Date): number {
  return value.getUTCHours() * 60 + value.getUTCMinutes();
}

/**
 * Qué día del calendario es ese instante en esa zona. El inverso de
 * `zonedWallTimeToUtc`: sirve para saber a qué jornada pertenece un turno, que
 * no siempre es la del mismo día en UTC.
 */
export function zonedDateOnly(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);

  return parts;
}

/**
 * A qué hora de pared corresponde ese instante en esa zona, en minutos desde la
 * medianoche. El complemento de `zonedDateOnly`: entre las dos reconstruyen la
 * hora que ve el negocio a partir de un `TIMESTAMPTZ`.
 */
export function zonedMinutesOfDay(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(instant);

  const read = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');

  return read('hour') * 60 + read('minute');
}
