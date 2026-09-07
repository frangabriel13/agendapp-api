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
 *
 * ⚠️ **`Retry-After` también lleva sufijo**, y acá estuvo escrito a secas hasta
 * que un e2e lo miró: el header que sale en un 429 es `Retry-After-short`, así
 * que la lista exponía uno que no existe y escondía el que sí. El front veía el
 * rechazo y no podía saber en cuánto reintentar — que es la única información
 * accionable de un 429.
 */
export const RATE_LIMIT_HEADERS = THROTTLERS.flatMap(({ name }) => [
  `X-RateLimit-Limit-${name}`,
  `X-RateLimit-Remaining-${name}`,
  `X-RateLimit-Reset-${name}`,
  `Retry-After-${name}`,
]);

/**
 * ── Los límites por endpoint ────────────────────────────────────────────────
 *
 * Están todos acá, y no cada uno al lado de su ruta, para que "¿qué límites
 * tiene la API?" se conteste abriendo un archivo. Cada `@Throttle` sobreescribe
 * el throttler que nombra y deja vivo el otro, así que un `{ short }` propio
 * sigue teniendo encima el `long` global de 100/min.
 *
 * ⚠️ **El tracker es la IP, y no puede ser el negocio.** El `ThrottlerGuard`
 * corre ANTES que el `JwtAuthGuard` —que es lo correcto: no se verifica una
 * firma para después decidir que el pedido sobraba—, así que cuando decide no
 * hay `request.user`. Leer el `tenantId` del token sin verificarlo sería peor
 * que no limitar: cualquiera pondría el de otro. La consecuencia a tener
 * presente es que un negocio abusivo con IPs rotativas no lo frena esto, sino
 * los permisos y el límite del proveedor de mails.
 */

/**
 * Lo que toca una credencial o canjea un token de un solo uso.
 *
 * Cinco por minuto es incómodo para adivinar y no se nota escribiendo mal la
 * contraseña dos veces. Va tanto en los endpoints que comparan una contraseña
 * como en los que canjean un link mandado por mail: los dos verifican un
 * secreto con argon2, que es caro a propósito, y sin límite ese costo lo paga
 * el servidor una vez por intento.
 */
export const CREDENTIALS_THROTTLE = { short: { limit: 5, ttl: 60_000 } };

/**
 * Lo que verifica un secreto con argon2 sin ser una credencial adivinable.
 *
 * El refresh token es `<id>.<secreto>` con 32 bytes al azar: no se adivina, así
 * que no hace falta el límite de una credencial. Pero cada intento igual paga
 * un argon2, y ese es el motivo del tope — no el robo del token, sino que
 * alguien use la verificación como amplificador de CPU.
 *
 * Veinte por minuto es holgado: un cliente renueva una vez cada quince minutos.
 */
export const TOKEN_EXCHANGE_THROTTLE = { short: { limit: 20, ttl: 60_000 } };

/**
 * Lo que hace salir un mail hacia una casilla ajena.
 *
 * Acá el costo no es del servidor: es la reputación del dominio. Un endpoint de
 * "reenviar invitación" sin tope es una máquina de mandarle mails a un tercero
 * **firmados por nosotros**, y eso se paga con el dominio en listas negras y
 * los mails que sí importan cayendo en spam.
 *
 * Diez por minuto deja cargar un equipo entero de una sentada.
 */
export const MAIL_THROTTLE = { short: { limit: 10, ttl: 60_000 } };

/**
 * Lo que le pega a Mercado Pago.
 *
 * Cada checkout crea una preferencia allá, y el límite de ellos es de ellos: si
 * lo agotamos, el que se queda sin cobrar es el negocio que sí tenía un cliente
 * esperando. El tope propio es para que un cliente en loop no consuma la cuota
 * de todos.
 */
export const PROVIDER_THROTTLE = { short: { limit: 20, ttl: 60_000 } };

/**
 * Mercado Pago avisa en ráfagas y reintenta, así que el límite global (10/s,
 * 100/min) le queda corto. Sigue habiendo tope porque es un endpoint público:
 * la firma se verifica antes de tocar la base, y un HMAC es barato, pero no
 * gratis.
 */
export const WEBHOOK_THROTTLE = {
  short: { limit: 30, ttl: 1_000 },
  long: { limit: 600, ttl: 60_000 },
};

/**
 * El portal público de un negocio: lo que ve alguien sin cuenta.
 *
 * Más ajustado que el global (10/s, 100/min) porque acá no hay nadie
 * identificado: el único costo de pedir es tener una IP. Sigue siendo cómodo
 * para una persona navegando —abrir el portal son tres pedidos— y molesto para
 * quien quiera bajarse el catálogo de todos los negocios.
 */
export const PORTAL_THROTTLE = {
  short: { limit: 5, ttl: 1_000 },
  long: { limit: 60, ttl: 60_000 },
};

/**
 * Reservar desde el portal. Mucho más duro que los `GET`, y no por el costo de
 * servirlo: cada reserva **le ocupa un hueco al negocio**. Sin un límite propio,
 * alguien le llena la agenda de la semana con teléfonos inventados y el límite
 * de lectura ni se entera, porque cincuenta reservas son cincuenta pedidos.
 *
 * Quince por hora deja pasar a una familia reservando desde la misma casa y no
 * a un script. **No alcanza solo** —las IPs son baratas—; es la primera capa,
 * y la que de verdad limita el daño es que un turno sin seña pagada se libera
 * a los `ABANDONED_HOLD_MINUTES`.
 */
export const BOOKING_THROTTLE = {
  short: { limit: 3, ttl: 60_000 },
  long: { limit: 15, ttl: 3_600_000 },
};
