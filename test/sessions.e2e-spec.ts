import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { JwtPayload } from '../src/modules/auth/types/jwt-payload';
import type { RecordingMailProvider } from './utils/recording-mail.provider';
import {
  auth,
  createTestApp,
  registerTenant,
  type RegisteredTenant,
  resetDatabase,
  type TestApp,
} from './utils/e2e-app';

/**
 * Invalidación de sesiones: el agujero que dejaba abierto revocar solo los
 * refresh tokens.
 *
 * Los tests de `auth.e2e-spec.ts` ya prueban que cambiar la contraseña revoca
 * los refresh. Lo que ninguno miraba es qué pasa con el **access token que ya
 * está emitido**, y la respuesta era: sigue funcionando hasta que expira. Con
 * `JWT_ACCESS_EXPIRES_IN` en 15 minutos, eso es un cuarto de hora de acceso
 * para alguien a quien acabás de sacarle la contraseña.
 *
 * Cada test de acá pregunta lo mismo de una forma distinta: **después de
 * cerrar la sesión, ¿el token viejo sigue entrando?**
 */

const CLAVE_NUEVA = 'ClaveNueva456!';

describe('Cierre de sesiones (e2e)', () => {
  let app: TestApp;
  let prisma: PrismaService;
  let mail: RecordingMailProvider;
  let jwt: JwtService;
  let tenant: RegisteredTenant;

  beforeAll(async () => {
    ({ app, prisma, mail } = await createTestApp());
    jwt = app.get(JwtService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    mail.clear();
    tenant = await registerTenant(app);
  });

  const server = () => app.getHttpServer();

  /**
   * El payload del token, listo para volver a firmar.
   *
   * Se arma campo por campo en vez de reusar lo que devuelve `decode`, que
   * viene con `iat` y `exp`: el módulo ya firma con un `expiresIn` global y
   * `jsonwebtoken` se niega a recibir las dos cosas a la vez.
   */
  function payloadDe(token: string): JwtPayload {
    const { sub, tenantId, employeeId, role, tv } =
      jwt.decode<JwtPayload>(token);

    return { sub, tenantId, employeeId, role, tv };
  }

  /** El request más barato que exige un token válido. */
  const conElToken = (token: string) =>
    request(server())
      .get('/auth/me')
      .set(...auth(token));

  const versionEnLaBase = async (): Promise<number> => {
    const { tokenVersion } = await prisma.user.findUniqueOrThrow({
      where: { id: tenant.userId },
      select: { tokenVersion: true },
    });

    return tokenVersion;
  };

  // ── Lo que el token lleva adentro ─────────────────────────────────────────

  describe('el claim', () => {
    it('el access token viaja con la versión del usuario', () => {
      const payload = jwt.decode<JwtPayload>(tenant.accessToken);

      expect(payload.tv).toBe(0);
    });

    it('un token sin el claim no entra', async () => {
      const sinVersion: Partial<JwtPayload> = payloadDe(tenant.accessToken);
      delete sinVersion.tv;

      // Firmado con el secreto de verdad: lo único que le falta es la versión.
      // Es el token que emitía esta misma API antes de que la columna
      // existiera, y tiene que quedar afuera — un token sin versión es un token
      // que no se puede invalidar.
      const viejo = jwt.sign(sinVersion);

      await conElToken(viejo).expect(401);
    });

    it('un token con una versión que no es la del usuario no entra', async () => {
      const payload = payloadDe(tenant.accessToken);
      const adulterado = jwt.sign({ ...payload, tv: payload.tv + 1 });

      await conElToken(adulterado).expect(401);
    });
  });

  // ── El botón de cerrar todo ───────────────────────────────────────────────

  describe('POST /auth/logout-all', () => {
    it('deja afuera al access token que ya estaba emitido', async () => {
      await conElToken(tenant.accessToken).expect(200);

      await request(server())
        .post('/auth/logout-all')
        .set(...auth(tenant.accessToken))
        .expect(204);

      // Sin esperar los quince minutos del vencimiento: al request siguiente.
      await conElToken(tenant.accessToken).expect(401);
    });

    it('también corta la renovación', async () => {
      await request(server())
        .post('/auth/logout-all')
        .set(...auth(tenant.accessToken))
        .expect(204);

      // Si el refresh siguiera vivo, cerrar todo no serviría de nada: quien
      // tuviera el refresh se emitiría un access nuevo y seguiría adentro.
      await request(server())
        .post('/auth/refresh')
        .send({ refreshToken: tenant.refreshToken })
        .expect(401);
    });

    it('alcanza a las demás sesiones, no solo a la que lo pide', async () => {
      const otraSesion = await request(server())
        .post('/auth/login')
        .send({ email: tenant.email, password: tenant.password })
        .expect(200);

      const { accessToken } = otraSesion.body as { accessToken: string };

      await request(server())
        .post('/auth/logout-all')
        .set(...auth(tenant.accessToken))
        .expect(204);

      await conElToken(accessToken).expect(401);
    });

    it('volver a loguearse funciona y el token nuevo sirve', async () => {
      await request(server())
        .post('/auth/logout-all')
        .set(...auth(tenant.accessToken))
        .expect(204);

      const response = await request(server())
        .post('/auth/login')
        .send({ email: tenant.email, password: tenant.password })
        .expect(200);

      const { accessToken } = response.body as { accessToken: string };

      await conElToken(accessToken).expect(200);
      expect(jwt.decode<JwtPayload>(accessToken).tv).toBe(1);
    });

    it('exige estar autenticado: no se cierran las sesiones de otro', async () => {
      await request(server()).post('/auth/logout-all').expect(401);
    });

    it('cerrar dos veces no rompe nada', async () => {
      await request(server())
        .post('/auth/logout-all')
        .set(...auth(tenant.accessToken))
        .expect(204);

      const { accessToken } = (
        await request(server())
          .post('/auth/login')
          .send({ email: tenant.email, password: tenant.password })
          .expect(200)
      ).body as { accessToken: string };

      await request(server())
        .post('/auth/logout-all')
        .set(...auth(accessToken))
        .expect(204);

      expect(await versionEnLaBase()).toBe(2);
    });

    it('no toca las sesiones de los demás usuarios', async () => {
      const otro = await registerTenant(app, 'Otro Negocio');

      await request(server())
        .post('/auth/logout-all')
        .set(...auth(tenant.accessToken))
        .expect(204);

      await conElToken(otro.accessToken).expect(200);
    });
  });

  // ── Los cambios de contraseña ─────────────────────────────────────────────

  describe('cambiar la contraseña', () => {
    it('cierra el access token viejo en el acto', async () => {
      await request(server())
        .patch('/auth/password')
        .set(...auth(tenant.accessToken))
        .send({ currentPassword: tenant.password, newPassword: CLAVE_NUEVA })
        .expect(204);

      // Esto es lo que antes seguía dando 200 durante quince minutos.
      await conElToken(tenant.accessToken).expect(401);
    });

    it('un cambio fallido no cierra nada', async () => {
      await request(server())
        .patch('/auth/password')
        .set(...auth(tenant.accessToken))
        .send({ currentPassword: 'NoEsLaMia123', newPassword: CLAVE_NUEVA })
        .expect(401);

      await conElToken(tenant.accessToken).expect(200);
      expect(await versionEnLaBase()).toBe(0);
    });
  });

  describe('resetear la contraseña por mail', () => {
    /** Pide el link y lo canjea, que es el recorrido que hace el usuario. */
    async function resetear(): Promise<void> {
      await request(server())
        .post('/auth/forgot-password')
        .send({ email: tenant.email })
        .expect(204);

      const token = mail.tokenFor(tenant.email);

      await request(server())
        .post('/auth/reset-password')
        .send({ token, password: CLAVE_NUEVA })
        .expect(204);
    }

    it('cierra el access token viejo en el acto', async () => {
      await resetear();

      // El caso que le da sentido al reset: se pidió porque alguien más entró
      // a la cuenta. Si su access token sobreviviera, cambiar la contraseña no
      // lo echaría hasta que expire.
      await conElToken(tenant.accessToken).expect(401);
    });

    it('sube la versión adentro de la misma transacción que la contraseña', async () => {
      await resetear();

      expect(await versionEnLaBase()).toBe(1);

      await request(server())
        .post('/auth/login')
        .send({ email: tenant.email, password: CLAVE_NUEVA })
        .expect(200);
    });
  });

  // ── Rotar el JWT_SECRET ───────────────────────────────────────────────────

  /**
   * Rotar el secreto no necesita ninguna maquinaria porque los refresh tokens
   * **no son JWT**: son filas opacas en la base y el secreto no los toca. Un
   * secreto nuevo mata todos los access tokens de una y cada cliente se
   * recupera con un refresh.
   *
   * ⚠️ Con una condición, y está documentada en `docs/frontend-context.md`: el
   * front tiene que **serializar** sus refresh. Si al rotar dispara uno por
   * cada request que quedó en el aire, el segundo cae en la detección de reuso
   * de `RefreshTokenService.rotate`, que revoca la familia entera — y la
   * rotación "sin que nadie la note" termina echando a todo el mundo.
   */
  describe('rotación del secreto', () => {
    it('un token firmado con otro secreto no entra', async () => {
      const conOtroSecreto = jwt.sign(payloadDe(tenant.accessToken), {
        secret: 'otro-secreto-que-mide-mas-de-treinta-y-dos-caracteres',
      });

      await conElToken(conOtroSecreto).expect(401);
    });

    it('el refresh token sobrevive: no está firmado con el secreto', async () => {
      const response = await request(server())
        .post('/auth/refresh')
        .send({ refreshToken: tenant.refreshToken })
        .expect(200);

      const { accessToken } = response.body as { accessToken: string };

      await conElToken(accessToken).expect(200);
    });
  });
});
