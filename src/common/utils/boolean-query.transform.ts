/**
 * `@Transform(booleanQueryParam('isActive'))` — convierte el `"true"`/`"false"`
 * de un query string en un booleano de verdad, y deja pasar cualquier otra cosa
 * para que `@IsBoolean()` la rechace con un 400.
 *
 * Lee el valor de `obj` (el objeto crudo) y no de `value` a propósito: el
 * `ValidationPipe` está configurado con `enableImplicitConversion`, que ya
 * convirtió `value` mirando el tipo declarado. Para un `boolean?` eso significa
 * `Boolean("cualquier cosa") === true`, así que un `?isActive=quizás` llegaría
 * como `true` y pasaría la validación sin chistar.
 */
export const booleanQueryParam =
  (property: string) =>
  ({ obj }: { obj: Record<string, unknown> }): unknown => {
    const raw = obj[property];

    if (raw === 'true' || raw === true) return true;
    if (raw === 'false' || raw === false) return false;

    return raw;
  };
