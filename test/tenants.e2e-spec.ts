import request from 'supertest';
import { TenantContextMissingError } from '../src/common/errors/tenant-context-missing.error';
import { TenantContextService } from '../src/common/tenant-context';
import type { PrismaService } from '../src/prisma/prisma.service';
import {
  auth,
  createTestApp,
  registerTenant,
  resetDatabase,
  type TestApp,
  type RegisteredTenant,
} from './utils/e2e-app';

describe('Tenants (e2e)', () => {
  let app: TestApp;
  let prisma: PrismaService;
  let tenant: RegisteredTenant;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await resetDatabase(prisma);
    tenant = await registerTenant(app, 'Peluquería Ana');
  });

  const server = () => app.getHttpServer();

  describe('GET /tenants/me', () => {
    it('devuelve el negocio del token con su plan', async () => {
      const response = await request(server())
        .get('/tenants/me')
        .set(...auth(tenant.accessToken))
        .expect(200);

      expect(response.body).toMatchObject({
        id: tenant.tenantId,
        businessName: 'Peluquería Ana',
        slug: 'peluqueria-ana',
        currency: 'ARS',
        subscriptionStatus: 'TRIAL',
        plan: { slug: 'basico', name: 'Básico' },
      });
    });

    it('exige token', async () => {
      await request(server()).get('/tenants/me').expect(401);
    });
  });

  describe('PATCH /tenants/me', () => {
    it('edita solo los campos enviados', async () => {
      const response = await request(server())
        .patch('/tenants/me')
        .set(...auth(tenant.accessToken))
        .send({ timezone: 'America/Montevideo', currency: 'UYU' })
        .expect(200);

      expect(response.body).toMatchObject({
        businessName: 'Peluquería Ana',
        timezone: 'America/Montevideo',
        currency: 'UYU',
      });
    });

    it('rechaza una zona horaria inexistente', async () => {
      await request(server())
        .patch('/tenants/me')
        .set(...auth(tenant.accessToken))
        .send({ timezone: 'Marte/Olympus' })
        .expect(400);
    });

    it('no permite editar el slug', async () => {
      const response = await request(server())
        .patch('/tenants/me')
        .set(...auth(tenant.accessToken))
        .send({ slug: 'otro-slug' })
        .expect(400);

      expect(JSON.stringify(response.body)).toContain('slug');

      const unchanged = await prisma.tenant.findFirst({
        where: { id: tenant.tenantId },
        select: { slug: true },
      });
      expect(unchanged?.slug).toBe('peluqueria-ana');
    });

    it('con body vacío devuelve el negocio sin cambios', async () => {
      const response = await request(server())
        .patch('/tenants/me')
        .set(...auth(tenant.accessToken))
        .send({})
        .expect(200);

      expect(response.body).toMatchObject({ businessName: 'Peluquería Ana' });
    });
  });

  describe('Branding', () => {
    it('viene creado desde el registro', async () => {
      const response = await request(server())
        .get('/tenants/me/branding')
        .set(...auth(tenant.accessToken))
        .expect(200);

      expect(response.body).toMatchObject({
        displayName: 'Peluquería Ana',
        logoUrl: null,
        primaryColor: null,
        description: null,
      });
    });

    it('se edita y persiste', async () => {
      await request(server())
        .patch('/tenants/me/branding')
        .set(...auth(tenant.accessToken))
        .send({
          primaryColor: '#7C3AED',
          description: 'Cortes y color en Palermo.',
          logoUrl: 'https://cdn.e2e.test/logo.png',
        })
        .expect(200);

      const response = await request(server())
        .get('/tenants/me/branding')
        .set(...auth(tenant.accessToken))
        .expect(200);

      expect(response.body).toMatchObject({
        primaryColor: '#7C3AED',
        description: 'Cortes y color en Palermo.',
        logoUrl: 'https://cdn.e2e.test/logo.png',
      });
    });

    it('distingue "no mandado" de null explícito', async () => {
      await request(server())
        .patch('/tenants/me/branding')
        .set(...auth(tenant.accessToken))
        .send({ primaryColor: '#7C3AED', description: 'Con descripción' })
        .expect(200);

      // Solo se manda description: el color no se toca.
      const response = await request(server())
        .patch('/tenants/me/branding')
        .set(...auth(tenant.accessToken))
        .send({ description: null })
        .expect(200);

      expect(response.body).toMatchObject({
        primaryColor: '#7C3AED',
        description: null,
      });
    });

    it('rechaza un color que no es hexadecimal', async () => {
      await request(server())
        .patch('/tenants/me/branding')
        .set(...auth(tenant.accessToken))
        .send({ primaryColor: 'violeta' })
        .expect(400);
    });
  });

  describe('Settings', () => {
    it('trae los valores por defecto del registro', async () => {
      const response = await request(server())
        .get('/tenants/me/settings')
        .set(...auth(tenant.accessToken))
        .expect(200);

      expect(response.body).toMatchObject({
        cancellationPolicyHours: 24,
        cancellationRefundType: 'FULL',
        cancellationRefundPercentage: null,
        requireDepositForBooking: false,
        defaultBufferMinutes: 0,
      });
    });

    it('exige el porcentaje al pasar a reembolso parcial', async () => {
      const response = await request(server())
        .patch('/tenants/me/settings')
        .set(...auth(tenant.accessToken))
        .send({ cancellationRefundType: 'PARTIAL' })
        .expect(400);

      expect(JSON.stringify(response.body)).toContain(
        'cancellationRefundPercentage',
      );
    });

    it('acepta el parcial con porcentaje y lo limpia al volver a NONE', async () => {
      const parcial = await request(server())
        .patch('/tenants/me/settings')
        .set(...auth(tenant.accessToken))
        .send({
          cancellationRefundType: 'PARTIAL',
          cancellationRefundPercentage: 50,
          cancellationPolicyHours: 48,
        })
        .expect(200);

      expect(parcial.body).toMatchObject({
        cancellationRefundType: 'PARTIAL',
        cancellationRefundPercentage: 50,
        cancellationPolicyHours: 48,
      });

      const sinReembolso = await request(server())
        .patch('/tenants/me/settings')
        .set(...auth(tenant.accessToken))
        .send({ cancellationRefundType: 'NONE' })
        .expect(200);

      expect(sinReembolso.body).toMatchObject({
        cancellationRefundType: 'NONE',
        cancellationRefundPercentage: null,
        cancellationPolicyHours: 48,
      });
    });

    it('rechaza valores fuera de rango', async () => {
      await request(server())
        .patch('/tenants/me/settings')
        .set(...auth(tenant.accessToken))
        .send({ cancellationRefundPercentage: 150 })
        .expect(400);

      await request(server())
        .patch('/tenants/me/settings')
        .set(...auth(tenant.accessToken))
        .send({ defaultBufferMinutes: -10 })
        .expect(400);
    });
  });

  describe('Autorización por rol', () => {
    it('un PROFESSIONAL lee la configuración pero no la edita', async () => {
      await prisma.employee.update({
        where: { id: tenant.employeeId },
        data: { role: 'PROFESSIONAL' },
      });

      // El rol se relee de la base en cada request: el mismo token ya vale menos.
      await request(server())
        .get('/tenants/me')
        .set(...auth(tenant.accessToken))
        .expect(200);

      await request(server())
        .patch('/tenants/me')
        .set(...auth(tenant.accessToken))
        .send({ businessName: 'Renombrado sin permiso' })
        .expect(403);

      await request(server())
        .patch('/tenants/me/branding')
        .set(...auth(tenant.accessToken))
        .send({ displayName: 'Renombrado sin permiso' })
        .expect(403);

      await request(server())
        .patch('/tenants/me/settings')
        .set(...auth(tenant.accessToken))
        .send({ cancellationPolicyHours: 0 })
        .expect(403);
    });

    it('un ADMINISTRATIVE sí puede editar', async () => {
      await prisma.employee.update({
        where: { id: tenant.employeeId },
        data: { role: 'ADMINISTRATIVE' },
      });

      await request(server())
        .patch('/tenants/me')
        .set(...auth(tenant.accessToken))
        .send({ businessName: 'Editado por administración' })
        .expect(200);
    });
  });

  describe('Aislamiento entre negocios', () => {
    let otro: RegisteredTenant;

    beforeEach(async () => {
      otro = await registerTenant(app, 'Estética Norte');
    });

    it('cada uno ve su propio negocio', async () => {
      const unoResponse = await request(server())
        .get('/tenants/me')
        .set(...auth(tenant.accessToken))
        .expect(200);
      const otroResponse = await request(server())
        .get('/tenants/me')
        .set(...auth(otro.accessToken))
        .expect(200);

      expect(unoResponse.body).toMatchObject({
        id: tenant.tenantId,
        businessName: 'Peluquería Ana',
      });
      expect(otroResponse.body).toMatchObject({
        id: otro.tenantId,
        businessName: 'Estética Norte',
      });
    });

    it('cada uno ve su propio branding y settings, aunque haya varias filas', async () => {
      await request(server())
        .patch('/tenants/me/branding')
        .set(...auth(tenant.accessToken))
        .send({ primaryColor: '#111111' })
        .expect(200);

      await request(server())
        .patch('/tenants/me/branding')
        .set(...auth(otro.accessToken))
        .send({ primaryColor: '#222222' })
        .expect(200);

      const uno = await request(server())
        .get('/tenants/me/branding')
        .set(...auth(tenant.accessToken))
        .expect(200);
      const dos = await request(server())
        .get('/tenants/me/branding')
        .set(...auth(otro.accessToken))
        .expect(200);

      expect(uno.body).toMatchObject({
        displayName: 'Peluquería Ana',
        primaryColor: '#111111',
      });
      expect(dos.body).toMatchObject({
        displayName: 'Estética Norte',
        primaryColor: '#222222',
      });
    });

    it('editar un negocio no toca al otro', async () => {
      await request(server())
        .patch('/tenants/me/settings')
        .set(...auth(tenant.accessToken))
        .send({ cancellationPolicyHours: 72, defaultBufferMinutes: 15 })
        .expect(200);

      const intacto = await request(server())
        .get('/tenants/me/settings')
        .set(...auth(otro.accessToken))
        .expect(200);

      expect(intacto.body).toMatchObject({
        cancellationPolicyHours: 24,
        defaultBufferMinutes: 0,
      });
    });
  });

  describe('Red de seguridad del tenant-scope', () => {
    it('una query scopeada sin contexto falla en vez de devolver todo', async () => {
      // Fuera de un request no hay AsyncLocalStorage montado.
      await expect(
        prisma.scoped.tenantSettings.findMany(),
      ).rejects.toBeInstanceOf(TenantContextMissingError);
    });

    it('runWithoutTenant es el único escape hatch: ahí sí ve todo', async () => {
      await registerTenant(app, 'Un Tercero');
      const context = app.get(TenantContextService);

      // El callback tiene que await-ear: las PrismaPromise son perezosas y sin
      // el await la query arrancaría con el contexto ya desmontado.
      const todas = await context.runWithoutTenant(
        async () => await prisma.scoped.tenantSettings.findMany(),
      );

      expect(todas.length).toBeGreaterThanOrEqual(2);
    });

    it('con contexto montado, la extension filtra sola', async () => {
      await registerTenant(app, 'Un Tercero');
      const context = app.get(TenantContextService);

      const propias = await context.run(
        { tenantId: tenant.tenantId, userId: tenant.userId },
        async () => await prisma.scoped.tenantSettings.findMany(),
      );

      expect(propias).toHaveLength(1);
      expect(propias[0]?.tenantId).toBe(tenant.tenantId);
    });

    it('una PrismaPromise devuelta sin await escapa del contexto (por eso el await no es opcional)', async () => {
      const context = app.get(TenantContextService);

      await expect(
        context.run({ tenantId: tenant.tenantId, userId: tenant.userId }, () =>
          prisma.scoped.tenantSettings.findMany(),
        ),
      ).rejects.toBeInstanceOf(TenantContextMissingError);
    });
  });
});
