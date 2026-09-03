import request from 'supertest';
import type { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type TestApp } from './utils/e2e-app';

/**
 * Los headers de seguridad, probados donde importa: sobre la app real.
 *
 * Este archivo existe porque el error fácil es poner Helmet en `main.ts`, que
 * **ningún test ejecuta** — la app de los e2e se levanta con
 * `createNestApplication()`. Estaría puesto, nadie lo notaría si desapareciera,
 * y el día que alguien reordene el bootstrap nos quedaríamos sin headers sin
 * enterarnos. Por eso va como middleware de `AppModule`, igual que el
 * `ValidationPipe` y el filtro de errores.
 */
describe('Headers de seguridad (e2e)', () => {
  let app: TestApp;
  let prisma: PrismaService;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  const health = () => request(app.getHttpServer()).get('/health');

  it('la app arranca y responde', async () => {
    await health().expect(200);
    expect(prisma).toBeDefined();
  });

  /** Que el navegador no adivine el tipo de una respuesta nuestra. */
  it('no deja adivinar el content-type', async () => {
    const response = await health().expect(200);

    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  /** Una API no se embebe en un iframe de nadie. */
  it('no se puede meter en un iframe', async () => {
    const response = await health().expect(200);

    expect(response.headers['x-frame-options']).toBe('SAMEORIGIN');
  });

  it('manda una política de contenido', async () => {
    const response = await health().expect(200);

    expect(response.headers['content-security-policy']).toContain(
      "default-src 'self'",
    );
  });

  /**
   * Helmet borra el `X-Powered-By: Express` que agrega Express solo. No es la
   * defensa más importante del mundo, pero es información sobre el stack que no
   * hay ninguna razón para publicar.
   */
  it('no anuncia con qué está hecho', async () => {
    const response = await health().expect(200);

    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  /**
   * Los headers también en un error, que es la respuesta que más se olvida.
   *
   * (No prueba el orden de los middlewares: ninguno de los dos corta la
   * cadena, así que invertirlos no cambia nada. Se comprobó mutando.)
   */
  it('también los manda en un 404', async () => {
    const response = await request(app.getHttpServer())
      .get('/no-existe')
      .expect(404);

    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
});
