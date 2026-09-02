/**
 * El censor de la auditoría.
 *
 * Es lo único que separa "registramos qué se pidió" de "guardamos contraseñas
 * en la base". Por eso es una función pura con tests propios y no un `map`
 * suelto adentro del interceptor: la regla tiene que poder leerse y romperse a
 * propósito en un test.
 *
 * **Censura de más antes que de menos.** El match es por *substring* del nombre
 * del campo, así que `passwordHash`, `currentPassword` y `refreshToken` caen
 * los tres sin enumerarlos. El costo es que un campo llamado `tokenCount`
 * también caería — y ese es el lado correcto para equivocarse.
 */

/** Lo que queda en lugar del valor. Se ve en la lista y explica por qué. */
export const REDACTED = '[censurado]';

/**
 * Fragmentos que hacen sospechoso a un nombre de campo, en minúsculas.
 *
 * Al agregar uno, agregá también su caso al spec: la lista sin test es una
 * lista que alguien "limpia" el día que le molesta un falso positivo.
 */
const SECRET_MARKERS = [
  'password',
  'passphrase',
  'token',
  'secret',
  'credential',
  'authorization',
  'signature',
  'apikey',
  'api_key',
  'privatekey',
  'private_key',
];

/**
 * Hasta dónde baja. Un body más anidado que esto no es un body legítimo, y
 * recorrerlo entero sería regalarle al que lo mandó el CPU del servidor.
 */
const MAX_DEPTH = 8;

/** Tope de elementos por array. Lo que sobra se resume, no se guarda. */
const MAX_ARRAY_ITEMS = 50;

/** Tope del texto de un valor suelto, en caracteres. */
const MAX_STRING_LENGTH = 1_000;

export function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase();

  return SECRET_MARKERS.some((marker) => normalized.includes(marker));
}

/**
 * Devuelve una copia de `value` sin secretos y con los tamaños acotados.
 *
 * No muta la entrada: el body sigue siendo el que el handler ya usó.
 */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) {
    return '[demasiado anidado]';
  }

  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'string') {
    return value.length > MAX_STRING_LENGTH
      ? `${value.slice(0, MAX_STRING_LENGTH)}…`
      : value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    const kept = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) => redactSecrets(item, depth + 1));

    return value.length > MAX_ARRAY_ITEMS
      ? [...kept, `[+${value.length - MAX_ARRAY_ITEMS} más]`]
      : kept;
  }

  if (typeof value === 'object') {
    const result: Record<string, unknown> = {};

    for (const [key, item] of Object.entries(value)) {
      result[key] = isSecretKey(key)
        ? REDACTED
        : redactSecrets(item, depth + 1);
    }

    return result;
  }

  // Funciones, symbols, bigints: nada de eso llega en un body JSON, y si llega
  // no es algo que valga la pena guardar.
  return null;
}

/**
 * Lo que va a la columna `changes`, o `undefined` si no hay nada que guardar.
 *
 * Un `{}` no se guarda: una fila de auditoría con `changes: {}` invita a
 * buscarle sentido a un objeto vacío. Que la columna sea `null` dice lo mismo
 * sin hacer perder el tiempo.
 */
export function toAuditChanges(
  body: unknown,
): Record<string, unknown> | undefined {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return undefined;
  }

  const redacted = redactSecrets(body) as Record<string, unknown>;

  return Object.keys(redacted).length === 0 ? undefined : redacted;
}
