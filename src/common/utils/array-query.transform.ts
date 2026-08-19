/**
 * `@Transform(arrayQueryParam)` — normaliza un query param repetible.
 *
 * Express parsea `?status=A&status=B` como array pero `?status=A` como string
 * suelto, así que sin esto un filtro con un solo valor llega con otra forma que
 * el mismo filtro con dos, y `@IsEnum(..., { each: true })` lo rechaza.
 *
 * El `undefined` pasa tal cual para que `@IsOptional()` siga viendo el campo
 * como ausente y no como un array vacío.
 */
export const arrayQueryParam = ({ value }: { value: unknown }): unknown => {
  if (value === undefined) {
    return undefined;
  }

  return Array.isArray(value) ? value : [value];
};
