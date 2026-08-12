/**
 * Traducción entre la fecha calendario que viaja por la API (`"2026-12-25"`) y
 * el tipo `DATE` de Postgres.
 *
 * Un feriado es un día del calendario, no un instante: el 25 de diciembre es el
 * 25 de diciembre en cualquier zona horaria. Prisma devuelve las columnas
 * `DATE` como `Date` a medianoche UTC, así que la conversión se hace siempre
 * con métodos UTC — usar los locales correría la fecha un día en cualquier
 * timezone al oeste de Greenwich, que es justo donde está el negocio.
 */

/** `"2026-12-25"`. Valida la forma; que el día exista lo chequea el parseo. */
export const DATE_ONLY_PATTERN =
  '^\\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\\d|3[01])$';

export const DATE_ONLY_REGEX = new RegExp(DATE_ONLY_PATTERN);

/** `"2026-12-25"` → `Date(2026-12-25T00:00:00Z)`, listo para guardar. */
export function dateOnlyToDate(value: string): Date {
  if (!DATE_ONLY_REGEX.test(value)) {
    throw new RangeError(
      `"${value}" no es una fecha válida (formato YYYY-MM-DD)`,
    );
  }

  const parsed = new Date(`${value}T00:00:00.000Z`);

  // El regex deja pasar un 31 de febrero; Postgres lo rechazaría con un 500.
  if (Number.isNaN(parsed.getTime()) || dateToDateOnly(parsed) !== value) {
    throw new RangeError(`"${value}" no existe en el calendario`);
  }

  return parsed;
}

/** `Date(2026-12-25T00:00:00Z)` → `"2026-12-25"`, listo para responder. */
export function dateToDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}
