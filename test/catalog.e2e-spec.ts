import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { PrismaService } from '../src/prisma/prisma.service';
import {
  auth,
  createTestApp,
  registerTenant,
  resetDatabase,
  switchPlan,
  type RegisteredTenant,
  type TestApp,
} from './utils/e2e-app';

interface ServiceResponse {
  id: string;
  name: string;
  priceCents: number;
  depositAmountCents: number | null;
  durationMinutes: number;
  bufferAfterMinutes: number;
  color: string | null;
  isActive: boolean;
  category: { id: string; name: string } | null;
}

interface CategoryResponse {
  id: string;
  name: string;
  displayOrder: number;
}

interface AssignmentResponse {
  employeeId: string;
  employeeName: string;
  branchId: string;
  branchName: string;
}

interface ResourceResponse {
  id: string;
  name: string;
  isActive: boolean;
  branch: { id: string; name: string };
}

interface ServiceResourceResponse {
  resourceId: string;
  resourceName: string;
  branchId: string;
  branchName: string;
}

function tokenFromUrl(activationUrl: string): string {
  const token = new URL(activationUrl).searchParams.get('token');

  if (!token) {
    throw new Error(`El link de activación no trae token: ${activationUrl}`);
  }

  return token;
}

describe('Catálogo (e2e)', () => {
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
    // El plan básico solo admite al dueño y una sucursal.
    await switchPlan(prisma, tenant.tenantId, 'empresa');
  });

  const server = () => app.getHttpServer();

  async function createCategory(
    body: Record<string, unknown> = {},
    token = tenant.accessToken,
  ): Promise<CategoryResponse> {
    const response = await request(server())
      .post('/service-categories')
      .set(...auth(token))
      .send({ name: 'Color', ...body })
      .expect(201);

    return response.body as CategoryResponse;
  }

  async function createService(
    body: Record<string, unknown> = {},
    token = tenant.accessToken,
  ): Promise<ServiceResponse> {
    const response = await request(server())
      .post('/services')
      .set(...auth(token))
      .send({
        name: 'Corte de dama',
        durationMinutes: 45,
        priceCents: 1_500_000,
        ...body,
      })
      .expect(201);

    return response.body as ServiceResponse;
  }

  async function createBranch(name = 'Sucursal Centro'): Promise<string> {
    const response = await request(server())
      .post('/branches')
      .set(...auth(tenant.accessToken))
      .send({ name })
      .expect(201);

    return (response.body as { id: string }).id;
  }

  /** Un empleado activado y logueado, con sus sucursales ya asignadas. */
  async function createProfessional(
    branchIds: string[] = [],
  ): Promise<{ id: string; accessToken: string }> {
    const email = `${randomUUID()}@e2e.test`;

    const invitation = await request(server())
      .post('/employees')
      .set(...auth(tenant.accessToken))
      .send({
        email,
        firstName: 'Lucía',
        lastName: 'Fernández',
        role: 'PROFESSIONAL',
        branchIds,
      })
      .expect(201);

    const body = invitation.body as {
      employee: { id: string };
      activationUrl: string;
    };

    await request(server())
      .post('/employees/activate')
      .send({
        token: tokenFromUrl(body.activationUrl),
        password: 'claveNueva123',
      })
      .expect(204);

    const login = await request(server())
      .post('/auth/login')
      .send({ email, password: 'claveNueva123' })
      .expect(200);

    return {
      id: body.employee.id,
      accessToken: (login.body as { accessToken: string }).accessToken,
    };
  }

  describe('Categorías', () => {
    it('crea una categoría y la lista por displayOrder', async () => {
      await createCategory({ name: 'Peinado', displayOrder: 2 });
      await createCategory({ name: 'Color', displayOrder: 1 });

      const response = await request(server())
        .get('/service-categories')
        .set(...auth(tenant.accessToken))
        .expect(200);

      expect((response.body as CategoryResponse[]).map((c) => c.name)).toEqual([
        'Color',
        'Peinado',
      ]);
    });

    it('rechaza un nombre repetido sin importar mayúsculas', async () => {
      await createCategory({ name: 'Color' });

      await request(server())
        .post('/service-categories')
        .set(...auth(tenant.accessToken))
        .send({ name: 'COLOR' })
        .expect(409);
    });

    it('dar de baja una categoría libera el nombre', async () => {
      const category = await createCategory({ name: 'Color' });

      await request(server())
        .delete(`/service-categories/${category.id}`)
        .set(...auth(tenant.accessToken))
        .expect(204);

      await createCategory({ name: 'Color' });
    });

    /**
     * El `ON DELETE SET NULL` de la FK no se dispara con baja lógica, así que el
     * service lo hace a mano. Sin esto los servicios quedarían apuntando a una
     * categoría invisible.
     */
    it('dar de baja una categoría deja sus servicios sin categoría, no los borra', async () => {
      const category = await createCategory();
      const service = await createService({ categoryId: category.id });

      await request(server())
        .delete(`/service-categories/${category.id}`)
        .set(...auth(tenant.accessToken))
        .expect(204);

      const response = await request(server())
        .get(`/services/${service.id}`)
        .set(...auth(tenant.accessToken))
        .expect(200);

      expect(response.body).toMatchObject({
        id: service.id,
        name: 'Corte de dama',
        category: null,
      });
    });

    it('no ve las categorías de otro negocio', async () => {
      const category = await createCategory();
      const otro = await registerTenant(app, 'Otra Peluquería');

      await request(server())
        .get(`/service-categories/${category.id}`)
        .set(...auth(otro.accessToken))
        .expect(404);
    });
  });

  describe('Servicios', () => {
    it('crea un servicio con su categoría', async () => {
      const category = await createCategory();

      const service = await createService({
        categoryId: category.id,
        depositAmountCents: 500_000,
        bufferAfterMinutes: 10,
        color: '#7C3AED',
      });

      expect(service).toMatchObject({
        name: 'Corte de dama',
        durationMinutes: 45,
        priceCents: 1_500_000,
        depositAmountCents: 500_000,
        bufferAfterMinutes: 10,
        color: '#7C3AED',
        isActive: true,
        category: { id: category.id, name: 'Color' },
      });
    });

    it('permite dos servicios con el mismo nombre en categorías distintas', async () => {
      const damas = await createCategory({ name: 'Damas' });
      const caballeros = await createCategory({ name: 'Caballeros' });

      await createService({ name: 'Corte', categoryId: damas.id });
      await createService({ name: 'Corte', categoryId: caballeros.id });
    });

    it('rechaza una categoría que no existe', async () => {
      await request(server())
        .post('/services')
        .set(...auth(tenant.accessToken))
        .send({
          name: 'Corte',
          durationMinutes: 30,
          priceCents: 100,
          categoryId: randomUUID(),
        })
        .expect(400);
    });

    it('rechaza la categoría de otro negocio', async () => {
      const otro = await registerTenant(app, 'Otra Peluquería');
      const ajena = await createCategory({ name: 'Ajena' }, otro.accessToken);

      await request(server())
        .post('/services')
        .set(...auth(tenant.accessToken))
        .send({
          name: 'Corte',
          durationMinutes: 30,
          priceCents: 100,
          categoryId: ajena.id,
        })
        .expect(400);
    });

    it('rechaza una seña mayor que el precio', async () => {
      await request(server())
        .post('/services')
        .set(...auth(tenant.accessToken))
        .send({
          name: 'Corte',
          durationMinutes: 30,
          priceCents: 1000,
          depositAmountCents: 2000,
        })
        .expect(400);
    });

    /**
     * El PATCH manda un solo campo, pero la regla compara los dos valores
     * finales: bajar el precio por debajo de una seña ya cargada también rompe.
     */
    it('rechaza bajar el precio por debajo de la seña ya cargada', async () => {
      const service = await createService({
        priceCents: 1_000_000,
        depositAmountCents: 500_000,
      });

      await request(server())
        .patch(`/services/${service.id}`)
        .set(...auth(tenant.accessToken))
        .send({ priceCents: 100_000 })
        .expect(400);
    });

    it('acepta bajar el precio si además se saca la seña', async () => {
      const service = await createService({
        priceCents: 1_000_000,
        depositAmountCents: 500_000,
      });

      const response = await request(server())
        .patch(`/services/${service.id}`)
        .set(...auth(tenant.accessToken))
        .send({ priceCents: 100_000, depositAmountCents: null })
        .expect(200);

      expect(response.body).toMatchObject({
        priceCents: 100_000,
        depositAmountCents: null,
      });
    });

    it.each([
      ['color fuera de formato', { color: 'rojo' }],
      ['duración en cero', { durationMinutes: 0 }],
      ['duración de más de un día', { durationMinutes: 1441 }],
      ['precio negativo', { priceCents: -1 }],
      ['buffer negativo', { bufferAfterMinutes: -5 }],
    ])('rechaza %s', async (_caso, override) => {
      await request(server())
        .post('/services')
        .set(...auth(tenant.accessToken))
        .send({
          name: 'Corte',
          durationMinutes: 30,
          priceCents: 100,
          ...override,
        })
        .expect(400);
    });

    it('filtra por categoría y por estado', async () => {
      const category = await createCategory();
      await createService({ name: 'Con categoría', categoryId: category.id });
      const suelto = await createService({ name: 'Sin categoría' });

      await request(server())
        .patch(`/services/${suelto.id}`)
        .set(...auth(tenant.accessToken))
        .send({ isActive: false })
        .expect(200);

      const porCategoria = await request(server())
        .get(`/services?categoryId=${category.id}`)
        .set(...auth(tenant.accessToken))
        .expect(200);

      expect(
        (porCategoria.body as ServiceResponse[]).map((s) => s.name),
      ).toEqual(['Con categoría']);

      const activos = await request(server())
        .get('/services?isActive=true')
        .set(...auth(tenant.accessToken))
        .expect(200);

      expect((activos.body as ServiceResponse[]).map((s) => s.name)).toEqual([
        'Con categoría',
      ]);
    });

    it('la baja es lógica: desaparece de la lista', async () => {
      const service = await createService();

      await request(server())
        .delete(`/services/${service.id}`)
        .set(...auth(tenant.accessToken))
        .expect(204);

      await request(server())
        .get(`/services/${service.id}`)
        .set(...auth(tenant.accessToken))
        .expect(404);
    });

    it('no ve los servicios de otro negocio', async () => {
      const service = await createService();
      const otro = await registerTenant(app, 'Otra Peluquería');

      await request(server())
        .get(`/services/${service.id}`)
        .set(...auth(otro.accessToken))
        .expect(404);
    });
  });

  describe('Permisos', () => {
    it('un PROFESSIONAL puede leer el catálogo pero no escribirlo', async () => {
      await createService();
      const professional = await createProfessional();

      await request(server())
        .get('/services')
        .set(...auth(professional.accessToken))
        .expect(200);

      await request(server())
        .post('/services')
        .set(...auth(professional.accessToken))
        .send({ name: 'Corte', durationMinutes: 30, priceCents: 100 })
        .expect(403);

      await request(server())
        .post('/service-categories')
        .set(...auth(professional.accessToken))
        .send({ name: 'Color' })
        .expect(403);
    });
  });

  describe('Quién presta cada servicio', () => {
    it('asigna un empleado a las sucursales donde trabaja', async () => {
      const centro = await createBranch('Sucursal Centro');
      const palermo = await createBranch('Sucursal Palermo');
      const professional = await createProfessional([centro, palermo]);
      const service = await createService();

      const response = await request(server())
        .put(`/services/${service.id}/employees`)
        .set(...auth(tenant.accessToken))
        .send({
          assignments: [
            { employeeId: professional.id, branchId: centro },
            { employeeId: professional.id, branchId: palermo },
          ],
        })
        .expect(200);

      const assignments = response.body as AssignmentResponse[];
      expect(assignments).toHaveLength(2);
      expect(assignments[0]).toMatchObject({
        employeeId: professional.id,
        employeeName: 'Lucía Fernández',
      });
      expect(assignments.map((a) => a.branchName).sort()).toEqual([
        'Sucursal Centro',
        'Sucursal Palermo',
      ]);
    });

    /**
     * La regla que sostiene la Fase 5: sin esto se podría ofrecer un turno en
     * una sucursal donde el profesional no trabaja.
     */
    it('rechaza asignar a alguien en una sucursal donde no trabaja', async () => {
      const centro = await createBranch('Sucursal Centro');
      const palermo = await createBranch('Sucursal Palermo');
      const professional = await createProfessional([centro]);
      const service = await createService();

      await request(server())
        .put(`/services/${service.id}/employees`)
        .set(...auth(tenant.accessToken))
        .send({
          assignments: [{ employeeId: professional.id, branchId: palermo }],
        })
        .expect(400);
    });

    it('rechaza al empleado de otro negocio', async () => {
      const centro = await createBranch();
      const service = await createService();
      const otro = await registerTenant(app, 'Otra Peluquería');

      await request(server())
        .put(`/services/${service.id}/employees`)
        .set(...auth(tenant.accessToken))
        .send({
          assignments: [{ employeeId: otro.employeeId, branchId: centro }],
        })
        .expect(400);
    });

    it('rechaza pares repetidos', async () => {
      const centro = await createBranch();
      const professional = await createProfessional([centro]);
      const service = await createService();

      await request(server())
        .put(`/services/${service.id}/employees`)
        .set(...auth(tenant.accessToken))
        .send({
          assignments: [
            { employeeId: professional.id, branchId: centro },
            { employeeId: professional.id, branchId: centro },
          ],
        })
        .expect(400);
    });

    it('reemplaza la lista completa en vez de acumular', async () => {
      const centro = await createBranch('Sucursal Centro');
      const palermo = await createBranch('Sucursal Palermo');
      const professional = await createProfessional([centro, palermo]);
      const service = await createService();

      await request(server())
        .put(`/services/${service.id}/employees`)
        .set(...auth(tenant.accessToken))
        .send({
          assignments: [
            { employeeId: professional.id, branchId: centro },
            { employeeId: professional.id, branchId: palermo },
          ],
        })
        .expect(200);

      const response = await request(server())
        .put(`/services/${service.id}/employees`)
        .set(...auth(tenant.accessToken))
        .send({
          assignments: [{ employeeId: professional.id, branchId: centro }],
        })
        .expect(200);

      expect(response.body as AssignmentResponse[]).toHaveLength(1);
    });

    it('un array vacío deja el servicio sin nadie que lo preste', async () => {
      const centro = await createBranch();
      const professional = await createProfessional([centro]);
      const service = await createService();

      await request(server())
        .put(`/services/${service.id}/employees`)
        .set(...auth(tenant.accessToken))
        .send({
          assignments: [{ employeeId: professional.id, branchId: centro }],
        })
        .expect(200);

      await request(server())
        .put(`/services/${service.id}/employees`)
        .set(...auth(tenant.accessToken))
        .send({ assignments: [] })
        .expect(200);

      const response = await request(server())
        .get(`/services/${service.id}/employees`)
        .set(...auth(tenant.accessToken))
        .expect(200);

      expect(response.body as AssignmentResponse[]).toEqual([]);
    });
  });

  describe('Recursos', () => {
    async function createResource(
      body: Record<string, unknown> = {},
    ): Promise<ResourceResponse> {
      const branchId = (body.branchId as string) ?? (await createBranch());

      const response = await request(server())
        .post('/resources')
        .set(...auth(tenant.accessToken))
        .send({ name: 'Camilla 1', ...body, branchId })
        .expect(201);

      return response.body as ResourceResponse;
    }

    it('crea un recurso en una sucursal', async () => {
      const branchId = await createBranch('Sucursal Centro');
      const resource = await createResource({ branchId });

      expect(resource).toMatchObject({
        name: 'Camilla 1',
        isActive: true,
        branch: { id: branchId, name: 'Sucursal Centro' },
      });
    });

    /**
     * El nombre es único por sucursal, no por negocio: el mismo recurso físico
     * puede llamarse igual en dos locales distintos.
     */
    it('permite el mismo nombre en dos sucursales, pero no en la misma', async () => {
      const centro = await createBranch('Sucursal Centro');
      const palermo = await createBranch('Sucursal Palermo');

      await createResource({ branchId: centro });
      await createResource({ branchId: palermo });

      await request(server())
        .post('/resources')
        .set(...auth(tenant.accessToken))
        .send({ name: 'CAMILLA 1', branchId: centro })
        .expect(409);
    });

    it('el plan Básico no incluye recursos', async () => {
      const branchId = await createBranch();
      await switchPlan(prisma, tenant.tenantId, 'basico');

      await request(server())
        .post('/resources')
        .set(...auth(tenant.accessToken))
        .send({ name: 'Camilla 1', branchId })
        .expect(403);
    });

    it('rechaza la sucursal de otro negocio', async () => {
      const otro = await registerTenant(app, 'Otra Peluquería');
      const ajena = await request(server())
        .post('/branches')
        .set(...auth(otro.accessToken))
        .send({ name: 'Sucursal Ajena' })
        .expect(201);

      await request(server())
        .post('/resources')
        .set(...auth(tenant.accessToken))
        .send({
          name: 'Camilla 1',
          branchId: (ajena.body as { id: string }).id,
        })
        .expect(400);
    });

    it('filtra por sucursal', async () => {
      const centro = await createBranch('Sucursal Centro');
      const palermo = await createBranch('Sucursal Palermo');
      await createResource({ name: 'Camilla Centro', branchId: centro });
      await createResource({ name: 'Camilla Palermo', branchId: palermo });

      const response = await request(server())
        .get(`/resources?branchId=${centro}`)
        .set(...auth(tenant.accessToken))
        .expect(200);

      expect((response.body as ResourceResponse[]).map((r) => r.name)).toEqual([
        'Camilla Centro',
      ]);
    });

    it('asigna recursos a un servicio y reemplaza la lista completa', async () => {
      const branchId = await createBranch('Sucursal Centro');
      const camilla = await createResource({ name: 'Camilla 1', branchId });
      const sala = await createResource({ name: 'Sala de color', branchId });
      const service = await createService();

      const asignados = await request(server())
        .put(`/services/${service.id}/resources`)
        .set(...auth(tenant.accessToken))
        .send({ resourceIds: [camilla.id, sala.id] })
        .expect(200);

      expect(
        (asignados.body as ServiceResourceResponse[]).map(
          (r) => r.resourceName,
        ),
      ).toEqual(['Camilla 1', 'Sala de color']);

      const reemplazados = await request(server())
        .put(`/services/${service.id}/resources`)
        .set(...auth(tenant.accessToken))
        .send({ resourceIds: [camilla.id] })
        .expect(200);

      expect(reemplazados.body as ServiceResourceResponse[]).toHaveLength(1);
    });

    it('rechaza recursos repetidos o de otro negocio', async () => {
      const branchId = await createBranch();
      const camilla = await createResource({ branchId });
      const service = await createService();

      await request(server())
        .put(`/services/${service.id}/resources`)
        .set(...auth(tenant.accessToken))
        .send({ resourceIds: [camilla.id, camilla.id] })
        .expect(400);

      await request(server())
        .put(`/services/${service.id}/resources`)
        .set(...auth(tenant.accessToken))
        .send({ resourceIds: [randomUUID()] })
        .expect(400);
    });

    it('un PROFESSIONAL puede leer los recursos pero no crearlos', async () => {
      const branchId = await createBranch();
      await createResource({ branchId });
      const professional = await createProfessional([branchId]);

      await request(server())
        .get('/resources')
        .set(...auth(professional.accessToken))
        .expect(200);

      await request(server())
        .post('/resources')
        .set(...auth(professional.accessToken))
        .send({ name: 'Camilla 2', branchId })
        .expect(403);
    });

    it('no ve los recursos de otro negocio', async () => {
      const resource = await createResource();
      const otro = await registerTenant(app, 'Otra Peluquería');

      await request(server())
        .get(`/resources/${resource.id}`)
        .set(...auth(otro.accessToken))
        .expect(404);
    });
  });
});
