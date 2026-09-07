import * as Sentry from '@sentry/nestjs';

/**
 * Inicializa Sentry, y tiene que ser **lo primero que importe `main.ts`**.
 *
 * El SDK instrumenta las librerías parchándolas al cargarlas (`http`, `pg`,
 * Express). Si Nest se importa antes, las referencias ya están tomadas y el
 * parche llega tarde: no rompe nada, simplemente no ve nada.
 *
 * Por lo mismo lee `process.env` en crudo y no el `ConfigService`: acá todavía
 * no hay contenedor de dependencias. Las variables están igual en
 * `env.schema.ts`, que es donde se validan y se documentan.
 *
 * **Sin `SENTRY_DSN` no se llama a `init` y el SDK entero queda en no-op.** Eso
 * cubre desarrollo y los tests e2e sin ninguna condición especial: los e2e
 * levantan la app con `createNestApplication()` y ni siquiera pasan por acá.
 */
const dsn = process.env.SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NODE_ENV ?? 'development',
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),

    /**
     * ⚠️ En `false` explícito, aunque ya sea el default.
     *
     * Con esto en `true`, el SDK manda headers, cookies y el cuerpo de cada
     * request. Este backend recibe contraseñas en el body de `/auth/login`, el
     * `Authorization` con el access token en casi todos lados y datos de
     * clientes de los negocios: eso no puede salir a un servicio externo por
     * un default.
     */
    sendDefaultPii: false,

    /**
     * La segunda pasada, por si algo se cuela igual.
     *
     * `sendDefaultPii: false` ya evita lo grueso, pero un header o un query
     * string puede llegar por otro camino —una integración nueva, un
     * `setContext` de alguien—. Esto corre sobre **todo** evento antes de
     * salir, así que el token no depende de que nadie se acuerde.
     */
    beforeSend(event) {
      if (event.request) {
        delete event.request.cookies;
        delete event.request.data;

        if (event.request.headers) {
          delete event.request.headers.authorization;
          delete event.request.headers.cookie;
        }
      }

      return event;
    },
  });
}
