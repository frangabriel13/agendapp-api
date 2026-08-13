/**
 * Los dos límites de rate que aplica la API, con nombre.
 *
 * `short` corta las ráfagas; `long` el uso sostenido. Los endpoints con
 * credenciales suman su propio `@Throttle` encima.
 */
export const THROTTLERS = [
  { name: 'short', ttl: 1_000, limit: 10 },
  { name: 'long', ttl: 60_000, limit: 100 },
];

/**
 * Headers de rate limit que el frontend tiene que poder leer.
 *
 * Se derivan de `THROTTLERS` porque `@nestjs/throttler` le pega **el nombre del
 * throttler como sufijo** a cada header: con dos límites nombrados no existe
 * `X-RateLimit-Limit` a secas, existen `X-RateLimit-Limit-short` y
 * `-long`. Escribirlos a mano es garantía de que queden mal el día que se
 * agregue o renombre un límite — y el síntoma sería mudo: el header viaja, pero
 * el navegador no se lo deja leer al JavaScript.
 */
export const RATE_LIMIT_HEADERS = [
  ...THROTTLERS.flatMap(({ name }) => [
    `X-RateLimit-Limit-${name}`,
    `X-RateLimit-Remaining-${name}`,
    `X-RateLimit-Reset-${name}`,
  ]),
  'Retry-After',
];
