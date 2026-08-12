/**
 * `@Transform(trim)` — saca los espacios de los strings antes de validarlos.
 *
 * Va antes que `@MinLength`/`@IsNotEmpty` para que `"   "` no pase por tener
 * tres caracteres. Los valores que no son string pasan de largo: validarlos es
 * tarea de los decorators que siguen, no de esta transformación.
 */
export const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
