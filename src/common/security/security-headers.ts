import helmet from 'helmet';
import type { RequestHandler } from 'express';

/**
 * Los headers de seguridad de las respuestas.
 *
 * **Va como middleware de `AppModule` y no en `main.ts`**, por el mismo motivo
 * que el `ValidationPipe` y el filtro de excepciones: la app que levantan los
 * e2e con `createNestApplication()` no ejecuta `main.ts`, así que todo lo que
 * viva ahí no se prueba nunca. Puesto acá, hay un e2e que lo fija.
 *
 * Casi todo lo que pone Helmet es gratis para una API JSON —`nosniff`, no
 * embeberse en un iframe, HSTS— y el único que necesita pensarse es el CSP,
 * porque el único HTML que este servidor devuelve es Swagger.
 */
export function securityHeaders(nodeEnv: string): RequestHandler {
  return helmet({
    // Swagger UI trae estilos y scripts inline. En producción no se monta
    // (ver `shouldExposeDocs`), así que ahí el CSP puede quedarse con el
    // default estricto de Helmet: no hay HTML propio al que aflojarle nada.
    contentSecurityPolicy: shouldExposeDocs(nodeEnv)
      ? {
          directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:'],
          },
        }
      : undefined,
  });
}

/**
 * Si se publica la documentación interactiva en `/api`.
 *
 * **En producción no.** No es que Swagger sea inseguro: es que publica el mapa
 * completo de la API —cada ruta, cada campo, cada regla de validación— a
 * cualquiera que pase, y eso es exactamente el trabajo de reconocimiento que
 * uno no tiene por qué regalar. En desarrollo es la herramienta principal.
 *
 * Es una función y no un `if` suelto en `main.ts` para poder probarla: el
 * bootstrap no lo ejecuta ningún test.
 */
export function shouldExposeDocs(nodeEnv: string): boolean {
  return nodeEnv !== 'production';
}
