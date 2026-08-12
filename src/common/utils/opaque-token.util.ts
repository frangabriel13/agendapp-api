import { randomBytes } from 'node:crypto';

/**
 * Tokens opacos con formato `<id>.<secret>`.
 *
 * Los usan el refresh token y la invitación de empleados, y los va a usar el
 * reset de contraseña. La idea es siempre la misma: en la base queda solo el
 * hash argon2 del `<secret>`, y el `<id>` viaja al lado para poder encontrar la
 * fila — un hash con salt no se puede buscar por igualdad, así que sin el id
 * habría que traer todas las filas y verificarlas de a una.
 *
 * No son JWT justamente porque tienen que poder revocarse: la verdad está en la
 * fila, no en la firma.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 32 bytes de entropía. Es lo único que el portador tiene que probar saber. */
export function generateTokenSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function buildOpaqueToken(id: string, secret: string): string {
  return `${id}.${secret}`;
}

/**
 * Parte el token en sus dos mitades. Devuelve `null` si viene mal formado —
 * el caller decide qué error mostrar, que nunca debería distinguir "mal
 * formado" de "no existe".
 *
 * El `secret` se corta en el PRIMER punto: base64url no genera puntos, pero si
 * alguna vez apareciera uno, partir por el último rompería el secreto.
 */
export function parseOpaqueToken(
  presented: string,
): { id: string; secret: string } | null {
  const separator = presented.indexOf('.');

  if (separator === -1) {
    return null;
  }

  const id = presented.slice(0, separator);
  const secret = presented.slice(separator + 1);

  if (!UUID_PATTERN.test(id) || secret.length === 0) {
    return null;
  }

  return { id, secret };
}
