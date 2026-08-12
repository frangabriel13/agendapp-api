import request from 'supertest';
import type { PrismaService } from '../src/prisma/prisma.service';
import {
  auth,
  createTestApp,
  registerTenant,
  resetDatabase,
  type TestApp,
  TEST_PASSWORD,
} from './utils/e2e-app';

describe('Auth (e2e)', () => {
  let app: TestApp;
  let prisma: PrismaService;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
  });

  const server = () => app.getHttpServer();

  describe('POST /auth/register', () => {
    it('crea negocio, dueño, suscripción y configuración en una sola llamada', async () => {
      const response = await request(server())
        .post('/auth/register')
        .send({
          email: 'ana@e2e.test',
          password: TEST_PASSWORD,
          firstName: 'Ana',
          lastName: 'Gómez',
          businessName: 'Peluquería Ana',
        })
        .expect(201);

      expect(response.body).toEqual({
        accessToken: expect.any(String) as string,
        refreshToken: expect.any(String) as string,
        tokenType: 'Bearer',
        expiresIn: expect.any(Number) as number,
      });

      const tenant = await prisma.tenant.findFirst({
        where: { businessName: 'Peluquería Ana' },
        include: {
          employees: true,
          subscriptions: true,
          branding: true,
          settings: true,
        },
      });

      expect(tenant).not.toBeNull();
      expect(tenant?.slug).toBe('peluqueria-ana');
      expect(tenant?.subscriptionStatus).toBe('TRIAL');
      expect(tenant?.employees).toHaveLength(1);
      expect(tenant?.employees[0]).toMatchObject({
        role: 'OWNER',
        isOwner: true,
      });
      expect(tenant?.subscriptions).toHaveLength(1);
      expect(tenant?.branding).not.toBeNull();
      expect(tenant?.settings).not.toBeNull();
    });

    it('rechaza un email ya registrado con 409', async () => {
      const existing = await registerTenant(app);

      await request(server())
        .post('/auth/register')
        .send({
          email: existing.email,
          password: TEST_PASSWORD,
          firstName: 'Otro',
          lastName: 'Dueño',
          businessName: 'Otro Negocio',
        })
        .expect(409);
    });

    it('no deja nada a medio crear si el registro falla', async () => {
      const existing = await registerTenant(app, 'Negocio Original');

      await request(server())
        .post('/auth/register')
        .send({
          email: existing.email,
          password: TEST_PASSWORD,
          firstName: 'Otro',
          lastName: 'Dueño',
          businessName: 'Negocio Duplicado',
        })
        .expect(409);

      await expect(
        prisma.tenant.count({ where: { businessName: 'Negocio Duplicado' } }),
      ).resolves.toBe(0);
      await expect(prisma.user.count()).resolves.toBe(1);
    });

    it('devuelve los errores de validación como array de mensajes', async () => {
      const response = await request(server())
        .post('/auth/register')
        .send({
          email: 'no-es-un-email',
          password: 'corta',
          firstName: 'A',
          lastName: 'B',
          businessName: 'X',
        })
        .expect(400);

      const body = response.body as { message: string[]; requestId: string };
      expect(Array.isArray(body.message)).toBe(true);
      expect(body.message.length).toBeGreaterThan(1);
      expect(body.requestId).toEqual(expect.any(String));
    });

    it('rechaza campos de contrabando', async () => {
      await request(server())
        .post('/auth/register')
        .send({
          email: 'colado@e2e.test',
          password: TEST_PASSWORD,
          firstName: 'Test',
          lastName: 'Usuario',
          businessName: 'Negocio',
          isAdmin: true,
        })
        .expect(400);
    });

    it('genera slugs distintos para dos negocios con el mismo nombre', async () => {
      await registerTenant(app, 'Peluquería Ana');
      await registerTenant(app, 'Peluquería Ana');

      const slugs = await prisma.tenant.findMany({ select: { slug: true } });
      const unique = new Set(slugs.map((t) => t.slug));

      expect(slugs).toHaveLength(2);
      expect(unique.size).toBe(2);
    });
  });

  describe('POST /auth/login', () => {
    it('devuelve tokens con las credenciales correctas', async () => {
      const tenant = await registerTenant(app);

      const response = await request(server())
        .post('/auth/login')
        .send({ email: tenant.email, password: tenant.password })
        .expect(200);

      expect(response.body).toMatchObject({ tokenType: 'Bearer' });
    });

    it('rechaza la contraseña incorrecta con 401', async () => {
      const tenant = await registerTenant(app);

      await request(server())
        .post('/auth/login')
        .send({ email: tenant.email, password: 'OtraClave123' })
        .expect(401);
    });

    it('rechaza un email inexistente con 401', async () => {
      await request(server())
        .post('/auth/login')
        .send({ email: 'nadie@e2e.test', password: TEST_PASSWORD })
        .expect(401);
    });
  });

  describe('GET /auth/me', () => {
    it('devuelve usuario, negocio y rol', async () => {
      const tenant = await registerTenant(app, 'Estética Sur');

      const response = await request(server())
        .get('/auth/me')
        .set(...auth(tenant.accessToken))
        .expect(200);

      expect(response.body).toMatchObject({
        user: { id: tenant.userId, email: tenant.email },
        tenant: { id: tenant.tenantId, businessName: 'Estética Sur' },
        employee: { id: tenant.employeeId, role: 'OWNER', isOwner: true },
      });
    });

    it('no expone el hash de la contraseña', async () => {
      const tenant = await registerTenant(app);

      const response = await request(server())
        .get('/auth/me')
        .set(...auth(tenant.accessToken))
        .expect(200);

      expect(JSON.stringify(response.body)).not.toContain('$argon2');
      expect(response.body).not.toHaveProperty('user.passwordHash');
    });

    it('rechaza sin token, con token basura y con token de otro secreto', async () => {
      await request(server()).get('/auth/me').expect(401);
      await request(server())
        .get('/auth/me')
        .set(...auth('no-es-un-token'))
        .expect(401);
      await request(server())
        .get('/auth/me')
        .set(...auth('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJmYWtlIn0.firma-invalida'))
        .expect(401);
    });

    it('corta el acceso apenas se desactiva al empleado, sin esperar a que venza el token', async () => {
      const tenant = await registerTenant(app);

      await request(server())
        .get('/auth/me')
        .set(...auth(tenant.accessToken))
        .expect(200);

      await prisma.employee.update({
        where: { id: tenant.employeeId },
        data: { isActive: false },
      });

      await request(server())
        .get('/auth/me')
        .set(...auth(tenant.accessToken))
        .expect(401);
    });
  });

  describe('POST /auth/refresh', () => {
    it('rota el token: devuelve uno nuevo y el viejo deja de servir', async () => {
      const tenant = await registerTenant(app);

      const rotated = await request(server())
        .post('/auth/refresh')
        .send({ refreshToken: tenant.refreshToken })
        .expect(200);

      const next = rotated.body as {
        accessToken: string;
        refreshToken: string;
      };
      expect(next.refreshToken).not.toBe(tenant.refreshToken);

      // El nuevo access token sirve.
      await request(server())
        .get('/auth/me')
        .set(...auth(next.accessToken))
        .expect(200);
    });

    it('ante el reuso de un token revocado, mata toda la familia de sesiones', async () => {
      const tenant = await registerTenant(app);

      const rotated = await request(server())
        .post('/auth/refresh')
        .send({ refreshToken: tenant.refreshToken })
        .expect(200);

      const next = rotated.body as { refreshToken: string };

      // Reuso del viejo: se asume robo.
      await request(server())
        .post('/auth/refresh')
        .send({ refreshToken: tenant.refreshToken })
        .expect(401);

      // Y el que era válido también queda revocado.
      await request(server())
        .post('/auth/refresh')
        .send({ refreshToken: next.refreshToken })
        .expect(401);
    });

    it('rechaza un refresh token inventado', async () => {
      await request(server())
        .post('/auth/refresh')
        .send({ refreshToken: 'cualquier-cosa' })
        .expect(401);
    });
  });

  describe('POST /auth/logout', () => {
    it('revoca la sesión: el refresh token deja de funcionar', async () => {
      const tenant = await registerTenant(app);

      await request(server())
        .post('/auth/logout')
        .send({ refreshToken: tenant.refreshToken })
        .expect(204);

      await request(server())
        .post('/auth/refresh')
        .send({ refreshToken: tenant.refreshToken })
        .expect(401);
    });

    it('no falla con un token inválido: cerrar sesión siempre "funciona"', async () => {
      await request(server())
        .post('/auth/logout')
        .send({ refreshToken: 'token-que-no-existe' })
        .expect(204);
    });
  });

  describe('PATCH /auth/password', () => {
    it('cambia la contraseña y cierra todas las sesiones abiertas', async () => {
      const tenant = await registerTenant(app);
      const nuevaClave = 'NuevaClave456';

      await request(server())
        .patch('/auth/password')
        .set(...auth(tenant.accessToken))
        .send({ currentPassword: tenant.password, newPassword: nuevaClave })
        .expect(204);

      // La contraseña vieja ya no entra.
      await request(server())
        .post('/auth/login')
        .send({ email: tenant.email, password: tenant.password })
        .expect(401);

      // La nueva sí.
      await request(server())
        .post('/auth/login')
        .send({ email: tenant.email, password: nuevaClave })
        .expect(200);

      // Y las sesiones que ya existían quedaron revocadas.
      await request(server())
        .post('/auth/refresh')
        .send({ refreshToken: tenant.refreshToken })
        .expect(401);
    });

    it('rechaza el cambio si la contraseña actual no es correcta', async () => {
      const tenant = await registerTenant(app);

      await request(server())
        .patch('/auth/password')
        .set(...auth(tenant.accessToken))
        .send({ currentPassword: 'NoEsLaMia123', newPassword: 'NuevaClave456' })
        .expect(401);
    });

    it('exige estar autenticado', async () => {
      await request(server())
        .patch('/auth/password')
        .send({ currentPassword: TEST_PASSWORD, newPassword: 'NuevaClave456' })
        .expect(401);
    });
  });

  describe('Rutas públicas', () => {
    it('GET /health responde sin token', async () => {
      const response = await request(server()).get('/health').expect(200);

      expect(response.body).toMatchObject({
        status: 'ok',
        info: { database: { status: 'up' } },
      });
    });
  });
});
