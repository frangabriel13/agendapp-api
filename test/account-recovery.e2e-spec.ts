import { UserTokenPurpose } from '@prisma/client';
import request from 'supertest';
import type { PrismaService } from '../src/prisma/prisma.service';
import {
  auth,
  createTestApp,
  registerTenant,
  type RegisteredTenant,
  resetDatabase,
  switchPlan,
  type TestApp,
  TEST_PASSWORD,
} from './utils/e2e-app';
import type { RecordingMailProvider } from './utils/recording-mail.provider';

const NEW_PASSWORD = 'OtraClave456';

/**
 * Reset de contraseña, verificación de email e invitación por mail.
 *
 * Todo esto se prueba de punta a punta porque el token **no se puede leer de la
 * base**: ahí queda solo su hash argon2. La única forma de tener el link es
 * sacarlo del mail, que es exactamente lo que hace una persona de verdad.
 */
describe('Recuperación de cuenta y mails (e2e)', () => {
  let app: TestApp;
  let prisma: PrismaService;
  let mail: RecordingMailProvider;
  let tenant: RegisteredTenant;

  beforeAll(async () => {
    ({ app, prisma, mail } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    mail.clear();
    tenant = await registerTenant(app);
    // El registro manda el mail de verificación: si no se limpia, cada test
    // arrancaría con un mail en la casilla y `lastTo` devolvería el equivocado.
    mail.clear();
  });

  const server = () => app.getHttpServer();

  /** Pide el reset y devuelve el token que viajó en el mail. */
  async function requestReset(email = tenant.email): Promise<string> {
    await request(server())
      .post('/auth/forgot-password')
      .send({ email })
      .expect(204);

    return mail.tokenFor(email);
  }

  const login = (email: string, password: string) =>
    request(server()).post('/auth/login').send({ email, password });

  describe('POST /auth/forgot-password', () => {
    it('le manda el link al dueño de la cuenta', async () => {
      await request(server())
        .post('/auth/forgot-password')
        .send({ email: tenant.email })
        .expect(204);

      const message = mail.lastTo(tenant.email);

      expect(message.subject).toBe('Restablecé tu contraseña');
      expect(message.text).toContain('/restablecer?token=');
    });

    /**
     * El corazón del diseño: la respuesta es idéntica exista o no la cuenta.
     * Si contestara 404 para las que no existen, cualquiera podría averiguar
     * qué emails están registrados sin tener credenciales de nada.
     */
    it('responde igual con un email que no existe, y no manda nada', async () => {
      await request(server())
        .post('/auth/forgot-password')
        .send({ email: 'nadie@e2e.test' })
        .expect(204);

      expect(mail.sent).toHaveLength(0);
    });

    it('emitir un link nuevo invalida el anterior', async () => {
      const viejo = await requestReset();
      const nuevo = await requestReset();

      expect(nuevo).not.toBe(viejo);

      await request(server())
        .post('/auth/reset-password')
        .send({ token: viejo, password: NEW_PASSWORD })
        .expect(400);

      await request(server())
        .post('/auth/reset-password')
        .send({ token: nuevo, password: NEW_PASSWORD })
        .expect(204);
    });

    /**
     * Un empleado invitado tiene cuenta pero todavía no eligió contraseña: no
     * hay nada que restablecer y su camino es el link de activación. Mandarle un
     * reset sería una segunda forma de tomar esa cuenta.
     */
    it('a un invitado que nunca activó la cuenta no le manda nada', async () => {
      await switchPlan(prisma, tenant.tenantId, 'pro');

      const invitado = 'sinclave@e2e.test';

      await request(server())
        .post('/employees')
        .set(...auth(tenant.accessToken))
        .send({
          email: invitado,
          firstName: 'Sin',
          lastName: 'Clave',
          role: 'PROFESSIONAL',
        })
        .expect(201);

      mail.clear();

      await request(server())
        .post('/auth/forgot-password')
        .send({ email: invitado })
        .expect(204);

      expect(mail.sent).toHaveLength(0);
    });
  });

  describe('POST /auth/reset-password', () => {
    it('cambia la contraseña y deja entrar con la nueva', async () => {
      const token = await requestReset();

      await request(server())
        .post('/auth/reset-password')
        .send({ token, password: NEW_PASSWORD })
        .expect(204);

      await login(tenant.email, NEW_PASSWORD).expect(200);
      await login(tenant.email, TEST_PASSWORD).expect(401);
    });

    /**
     * Si el reset se pidió porque alguien más entró a la cuenta, dejarle la
     * sesión abierta volvería inútil el cambio de contraseña.
     */
    it('cierra las sesiones que ya estaban abiertas', async () => {
      const token = await requestReset();

      await request(server())
        .post('/auth/reset-password')
        .send({ token, password: NEW_PASSWORD })
        .expect(204);

      await request(server())
        .post('/auth/refresh')
        .send({ refreshToken: tenant.refreshToken })
        .expect(401);
    });

    it('el link sirve una sola vez', async () => {
      const token = await requestReset();

      await request(server())
        .post('/auth/reset-password')
        .send({ token, password: NEW_PASSWORD })
        .expect(204);

      await request(server())
        .post('/auth/reset-password')
        .send({ token, password: 'TerceraClave789' })
        .expect(400);
    });

    it('rechaza un token vencido', async () => {
      const token = await requestReset();

      await prisma.userToken.updateMany({
        where: { purpose: UserTokenPurpose.PASSWORD_RESET },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });

      await request(server())
        .post('/auth/reset-password')
        .send({ token, password: NEW_PASSWORD })
        .expect(400);
    });

    it('rechaza un token mal formado', async () => {
      await request(server())
        .post('/auth/reset-password')
        .send({ token: 'esto-no-es-un-token', password: NEW_PASSWORD })
        .expect(400);
    });

    /**
     * El propósito es parte de lo que se valida, no una etiqueta. Si no lo
     * fuera, el link de verificación —que se manda solo, sin que nadie lo pida—
     * serviría para cambiar la contraseña.
     */
    it('un token de verificación no sirve para resetear', async () => {
      mail.clear();

      await request(server())
        .post('/auth/verify-email/resend')
        .set(...auth(tenant.accessToken))
        .expect(204);

      const verificacion = mail.tokenFor(tenant.email);

      await request(server())
        .post('/auth/reset-password')
        .send({ token: verificacion, password: NEW_PASSWORD })
        .expect(400);
    });

    it('exige una contraseña que cumpla las mismas reglas que el registro', async () => {
      const token = await requestReset();

      await request(server())
        .post('/auth/reset-password')
        .send({ token, password: 'corta' })
        .expect(400);
    });
  });

  describe('Verificación de email', () => {
    it('el registro manda el mail solo', async () => {
      mail.clear();
      const nuevo = await registerTenant(app, 'Otro Negocio');

      expect(mail.lastTo(nuevo.email).subject).toBe('Confirmá tu email');
    });

    it('el link deja el email confirmado', async () => {
      mail.clear();
      const nuevo = await registerTenant(app, 'Negocio Confirmado');
      const token = mail.tokenFor(nuevo.email);

      await request(server())
        .post('/auth/verify-email')
        .send({ token })
        .expect(204);

      const me = await request(server())
        .get('/auth/me')
        .set(...auth(nuevo.accessToken))
        .expect(200);

      const body = me.body as { user: { emailVerifiedAt: string | null } };
      expect(body.user.emailVerifiedAt).not.toBeNull();
    });

    it('el link sirve una sola vez', async () => {
      mail.clear();
      const nuevo = await registerTenant(app, 'Negocio Doble Click');
      const token = mail.tokenFor(nuevo.email);

      await request(server())
        .post('/auth/verify-email')
        .send({ token })
        .expect(204);

      await request(server())
        .post('/auth/verify-email')
        .send({ token })
        .expect(400);
    });

    it('el reenvío manda un link nuevo', async () => {
      mail.clear();

      await request(server())
        .post('/auth/verify-email/resend')
        .set(...auth(tenant.accessToken))
        .expect(204);

      expect(mail.lastTo(tenant.email).subject).toBe('Confirmá tu email');
    });

    /**
     * Acá sí se puede ser explícito: el endpoint pide token, así que quien
     * pregunta ya demostró ser el dueño de la cuenta.
     */
    it('reenviar cuando ya está confirmado devuelve 409', async () => {
      mail.clear();
      const nuevo = await registerTenant(app, 'Negocio Ya Confirmado');

      await request(server())
        .post('/auth/verify-email')
        .send({ token: mail.tokenFor(nuevo.email) })
        .expect(204);

      await request(server())
        .post('/auth/verify-email/resend')
        .set(...auth(nuevo.accessToken))
        .expect(409);
    });

    it('sin token no se puede verificar nada', async () => {
      await request(server())
        .post('/auth/verify-email')
        .send({ token: 'no-existe' })
        .expect(400);
    });
  });

  describe('Invitación de empleados por mail', () => {
    beforeEach(async () => {
      await switchPlan(prisma, tenant.tenantId, 'pro');
      mail.clear();
    });

    const invite = (email: string) =>
      request(server())
        .post('/employees')
        .set(...auth(tenant.accessToken))
        .send({
          email,
          firstName: 'Ana',
          lastName: 'Gómez',
          role: 'PROFESSIONAL',
        });

    it('le llega el link al empleado y el mail nombra al negocio', async () => {
      const response = await invite('ana@e2e.test').expect(201);

      const body = response.body as {
        activationUrl: string;
        emailSent: boolean;
      };

      expect(body.emailSent).toBe(true);

      const message = mail.lastTo('ana@e2e.test');
      expect(message.subject).toContain(tenant.businessName);
      expect(message.text).toContain(body.activationUrl);
    });

    it('el link del mail activa la cuenta', async () => {
      await invite('activa@e2e.test').expect(201);

      await request(server())
        .post('/employees/activate')
        .send({
          token: mail.tokenFor('activa@e2e.test'),
          password: NEW_PASSWORD,
        })
        .expect(204);

      await login('activa@e2e.test', NEW_PASSWORD).expect(200);
    });

    it('el reenvío manda un mail nuevo', async () => {
      const created = await invite('reenvio@e2e.test').expect(201);
      const employeeId = (created.body as { employee: { id: string } }).employee
        .id;

      mail.clear();

      await request(server())
        .post(`/employees/${employeeId}/invitation`)
        .set(...auth(tenant.accessToken))
        .expect(201);

      expect(mail.to('reenvio@e2e.test')).toHaveLength(1);
    });

    /**
     * La razón por la que `activationUrl` sigue viajando en la respuesta: si el
     * proveedor de mail está caído, el alta igual se hizo y el dueño tiene cómo
     * hacerle llegar el link al empleado.
     */
    it('si el mail falla, el empleado se crea igual y el link viaja en la respuesta', async () => {
      mail.failing(true);

      const response = await invite('sinmail@e2e.test').expect(201);
      const body = response.body as {
        activationUrl: string;
        emailSent: boolean;
      };

      expect(body.emailSent).toBe(false);
      expect(body.activationUrl).toContain('/activar?token=');

      mail.failing(false);

      // El link de la respuesta funciona igual que el que hubiera ido por mail.
      await request(server())
        .post('/employees/activate')
        .send({
          token: new URL(body.activationUrl).searchParams.get('token'),
          password: NEW_PASSWORD,
        })
        .expect(204);
    });
  });

  /** Un proveedor de mail caído no puede voltear el alta de un negocio. */
  it('el registro funciona aunque el mail no salga', async () => {
    mail.failing(true);

    await request(server())
      .post('/auth/register')
      .send({
        email: 'sinmail@e2e.test',
        password: TEST_PASSWORD,
        firstName: 'Sin',
        lastName: 'Mail',
        businessName: 'Negocio Sin Mail',
      })
      .expect(201);

    mail.failing(false);

    await login('sinmail@e2e.test', TEST_PASSWORD).expect(200);
  });
});
