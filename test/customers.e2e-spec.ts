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

interface TagResponse {
  id: string;
  name: string;
  color: string | null;
  customerCount: number;
}

interface CustomerResponse {
  id: string;
  firstName: string;
  lastName: string | null;
  phone: string;
  email: string | null;
  dateOfBirth: string | null;
  notes: string | null;
  tags: { id: string; name: string; color: string | null }[];
}

interface PaginatedCustomers {
  data: CustomerResponse[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

interface DuplicateBody {
  statusCode: number;
  message: string;
  existingCustomer: CustomerResponse;
}

function tokenFromUrl(activationUrl: string): string {
  const token = new URL(activationUrl).searchParams.get('token');

  if (!token) {
    throw new Error(`El link de activación no trae token: ${activationUrl}`);
  }

  return token;
}

describe('Clientes (e2e)', () => {
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
    // El plan básico solo admite al dueño; algunos tests suman un empleado.
    await switchPlan(prisma, tenant.tenantId, 'empresa');
  });

  const server = () => app.getHttpServer();

  async function createCustomer(
    body: Record<string, unknown> = {},
    token = tenant.accessToken,
  ): Promise<CustomerResponse> {
    const response = await request(server())
      .post('/customers')
      .set(...auth(token))
      .send({ firstName: 'María', phone: '11 5555-1234', ...body })
      .expect(201);

    return response.body as CustomerResponse;
  }

  async function createTag(
    body: Record<string, unknown> = {},
  ): Promise<TagResponse> {
    const response = await request(server())
      .post('/customer-tags')
      .set(...auth(tenant.accessToken))
      .send({ name: 'VIP', ...body })
      .expect(201);

    return response.body as TagResponse;
  }

  /** Un profesional activado y logueado: sirve para probar los permisos. */
  async function createProfessional(): Promise<string> {
    const email = `${randomUUID()}@e2e.test`;

    const invitation = await request(server())
      .post('/employees')
      .set(...auth(tenant.accessToken))
      .send({
        email,
        firstName: 'Lucía',
        lastName: 'Fernández',
        role: 'PROFESSIONAL',
      })
      .expect(201);

    const body = invitation.body as { activationUrl: string };

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

    return (login.body as { accessToken: string }).accessToken;
  }

  describe('Alta', () => {
    it('crea un cliente con los datos completos', async () => {
      const customer = await createCustomer({
        lastName: 'González',
        email: 'Maria@Ejemplo.COM',
        dateOfBirth: '1990-04-25',
        notes: 'Prefiere turnos a la mañana',
      });

      expect(customer).toMatchObject({
        firstName: 'María',
        lastName: 'González',
        phone: '11 5555-1234',
        email: 'maria@ejemplo.com',
        dateOfBirth: '1990-04-25',
        tags: [],
      });
    });

    it('el apellido, el email y la fecha son opcionales', async () => {
      const customer = await createCustomer();

      expect(customer).toMatchObject({
        lastName: null,
        email: null,
        dateOfBirth: null,
        notes: null,
      });
    });

    it.each([
      ['sin teléfono', { phone: undefined }],
      ['con un teléfono sin números', { phone: '+()-.' }],
      ['con letras en el teléfono', { phone: '11 5555-ABCD' }],
      ['sin nombre', { firstName: undefined }],
      ['con un email inválido', { email: 'no-es-un-mail' }],
      ['con una fecha que no existe', { dateOfBirth: '1990-02-31' }],
      ['con una fecha futura', { dateOfBirth: '2999-01-01' }],
    ])('rechaza un alta %s', async (_caso, body) => {
      await request(server())
        .post('/customers')
        .set(...auth(tenant.accessToken))
        .send({ firstName: 'María', phone: '11 5555-1234', ...body })
        .expect(400);
    });
  });

  describe('Un teléfono, un cliente', () => {
    it('rechaza el repetido con 409 y devuelve la ficha existente', async () => {
      const existente = await createCustomer({ lastName: 'González' });

      const response = await request(server())
        .post('/customers')
        .set(...auth(tenant.accessToken))
        .send({ firstName: 'Otra', phone: '11 5555-1234' })
        .expect(409);

      const body = response.body as DuplicateBody;

      expect(body.message).toContain('teléfono');
      expect(body.existingCustomer).toMatchObject({
        id: existente.id,
        firstName: 'María',
        lastName: 'González',
      });
    });

    /**
     * El caso que justifica la columna normalizada: el mismo número dictado
     * distinto tiene que chocar igual.
     */
    it.each([
      '+54 9 11 5555-1234',
      '011 5555-1234',
      '(011) 5555.1234',
      '5411 5555 1234',
    ])('reconoce %s como el mismo número', async (phone) => {
      await createCustomer();

      await request(server())
        .post('/customers')
        .set(...auth(tenant.accessToken))
        .send({ firstName: 'Otra', phone })
        .expect(409);
    });

    it('el teléfono de otro negocio no molesta', async () => {
      await createCustomer();

      const otro = await registerTenant(app, 'Otro Negocio');

      await request(server())
        .post('/customers')
        .set(...auth(otro.accessToken))
        .send({ firstName: 'María', phone: '11 5555-1234' })
        .expect(201);
    });

    it('dar de baja una ficha libera el teléfono', async () => {
      const customer = await createCustomer();

      await request(server())
        .delete(`/customers/${customer.id}`)
        .set(...auth(tenant.accessToken))
        .expect(204);

      await request(server())
        .post('/customers')
        .set(...auth(tenant.accessToken))
        .send({ firstName: 'Otra', phone: '11 5555-1234' })
        .expect(201);
    });

    it('editar el teléfono pasa por el mismo chequeo', async () => {
      await createCustomer({ phone: '11 5555-1234' });
      const segunda = await createCustomer({
        firstName: 'Ana',
        phone: '11 4444-9999',
      });

      await request(server())
        .patch(`/customers/${segunda.id}`)
        .set(...auth(tenant.accessToken))
        .send({ phone: '+54 9 11 5555-1234' })
        .expect(409);
    });

    it('reguardar el mismo teléfono en la misma ficha no molesta', async () => {
      const customer = await createCustomer();

      await request(server())
        .patch(`/customers/${customer.id}`)
        .set(...auth(tenant.accessToken))
        .send({ phone: '11 5555-1234', firstName: 'Mariana' })
        .expect(200);
    });
  });

  describe('Búsqueda paginada', () => {
    beforeEach(async () => {
      await createCustomer({
        firstName: 'María',
        lastName: 'González',
        phone: '11 5555-1234',
        email: 'maria@ejemplo.com',
      });
      await createCustomer({
        firstName: 'Ana',
        lastName: 'Pérez',
        phone: '11 4444-9999',
      });
      await createCustomer({
        firstName: 'Bruno',
        lastName: 'González',
        phone: '11 3333-7777',
      });
    });

    const search = async (query: string): Promise<PaginatedCustomers> => {
      const response = await request(server())
        .get(`/customers?${query}`)
        .set(...auth(tenant.accessToken))
        .expect(200);

      return response.body as PaginatedCustomers;
    };

    it('lista alfabéticamente con el total', async () => {
      const result = await search('');

      expect(result.data.map((c) => c.firstName)).toEqual([
        'Ana',
        'Bruno',
        'María',
      ]);
      expect(result.meta).toEqual({
        page: 1,
        pageSize: 20,
        total: 3,
        totalPages: 1,
      });
    });

    it('parte en páginas', async () => {
      const primera = await search('page=1&pageSize=2');
      const segunda = await search('page=2&pageSize=2');

      expect(primera.data).toHaveLength(2);
      expect(segunda.data).toHaveLength(1);
      expect(segunda.meta).toMatchObject({ total: 3, totalPages: 2 });
    });

    it('una página más allá del final devuelve vacío, no 404', async () => {
      const result = await search('page=99');

      expect(result.data).toEqual([]);
      expect(result.meta.total).toBe(3);
    });

    it('busca por nombre sin importar mayúsculas ni tildes tipeadas', async () => {
      const result = await search('search=ANA');

      expect(result.data.map((c) => c.firstName)).toEqual(['Ana']);
    });

    it('busca por apellido', async () => {
      const result = await search('search=gonz');

      expect(result.data.map((c) => c.firstName)).toEqual(['Bruno', 'María']);
    });

    it('busca por email', async () => {
      const result = await search('search=maria@ejemplo');

      expect(result.data).toHaveLength(1);
    });

    /** El teléfono se compara normalizado: da igual cómo lo tipeen. */
    it.each(['5555-1234', '+54 9 11 5555 1234', '1155551234'])(
      'encuentra por teléfono tipeado como %s',
      async (term) => {
        const result = await search(`search=${encodeURIComponent(term)}`);

        expect(result.data.map((c) => c.firstName)).toEqual(['María']);
      },
    );

    it('cruza nombre y apellido cuando se escribe el nombre completo', async () => {
      const result = await search(
        `search=${encodeURIComponent('maría gonzález')}`,
      );

      expect(result.data.map((c) => c.firstName)).toEqual(['María']);
    });

    it('también al revés: apellido y después nombre', async () => {
      const result = await search(
        `search=${encodeURIComponent('gonzález maría')}`,
      );

      expect(result.data.map((c) => c.firstName)).toEqual(['María']);
    });

    it('no trae clientes de otro negocio', async () => {
      const otro = await registerTenant(app, 'Otro Negocio');

      const response = await request(server())
        .get('/customers')
        .set(...auth(otro.accessToken))
        .expect(200);

      expect((response.body as PaginatedCustomers).meta.total).toBe(0);
    });

    it('un cliente dado de baja desaparece de la lista', async () => {
      const { data } = await search('search=Ana');

      await request(server())
        .delete(`/customers/${data[0].id}`)
        .set(...auth(tenant.accessToken))
        .expect(204);

      expect((await search('')).meta.total).toBe(2);
    });

    it('rechaza un pageSize desmedido', async () => {
      await request(server())
        .get('/customers?pageSize=5000')
        .set(...auth(tenant.accessToken))
        .expect(400);
    });
  });

  describe('Etiquetas', () => {
    it('crea una etiqueta y arranca sin clientes', async () => {
      const tag = await createTag({ color: '#7C3AED' });

      expect(tag).toMatchObject({
        name: 'VIP',
        color: '#7C3AED',
        customerCount: 0,
      });
    });

    it('rechaza un nombre repetido sin importar mayúsculas', async () => {
      await createTag({ name: 'VIP' });

      await request(server())
        .post('/customer-tags')
        .set(...auth(tenant.accessToken))
        .send({ name: 'vip' })
        .expect(409);
    });

    it('rechaza un color que no sea hexadecimal', async () => {
      await request(server())
        .post('/customer-tags')
        .set(...auth(tenant.accessToken))
        .send({ name: 'VIP', color: 'violeta' })
        .expect(400);
    });

    it('pone y saca etiquetas reemplazando el set completo', async () => {
      const customer = await createCustomer();
      const vip = await createTag({ name: 'VIP' });
      const debe = await createTag({ name: 'Debe seña' });

      const puestas = await request(server())
        .put(`/customers/${customer.id}/tags`)
        .set(...auth(tenant.accessToken))
        .send({ tagIds: [vip.id, debe.id] })
        .expect(200);

      expect(puestas.body).toHaveLength(2);

      const reemplazadas = await request(server())
        .put(`/customers/${customer.id}/tags`)
        .set(...auth(tenant.accessToken))
        .send({ tagIds: [vip.id] })
        .expect(200);

      expect(reemplazadas.body).toEqual([
        expect.objectContaining({ id: vip.id }),
      ]);
    });

    it('vienen colgadas del cliente al leerlo', async () => {
      const customer = await createCustomer();
      const vip = await createTag({ name: 'VIP', color: '#7C3AED' });

      await request(server())
        .put(`/customers/${customer.id}/tags`)
        .set(...auth(tenant.accessToken))
        .send({ tagIds: [vip.id] })
        .expect(200);

      const response = await request(server())
        .get(`/customers/${customer.id}`)
        .set(...auth(tenant.accessToken))
        .expect(200);

      expect((response.body as CustomerResponse).tags).toEqual([
        { id: vip.id, name: 'VIP', color: '#7C3AED' },
      ]);
    });

    it('filtra la lista de clientes por etiqueta', async () => {
      const conTag = await createCustomer({ phone: '11 1111-1111' });
      await createCustomer({ firstName: 'Ana', phone: '11 2222-2222' });
      const vip = await createTag();

      await request(server())
        .put(`/customers/${conTag.id}/tags`)
        .set(...auth(tenant.accessToken))
        .send({ tagIds: [vip.id] })
        .expect(200);

      const response = await request(server())
        .get(`/customers?tagId=${vip.id}`)
        .set(...auth(tenant.accessToken))
        .expect(200);

      expect((response.body as PaginatedCustomers).data).toEqual([
        expect.objectContaining({ id: conTag.id }),
      ]);
    });

    it('cuenta cuántos clientes tiene cada una', async () => {
      const customer = await createCustomer();
      const vip = await createTag();

      await request(server())
        .put(`/customers/${customer.id}/tags`)
        .set(...auth(tenant.accessToken))
        .send({ tagIds: [vip.id] })
        .expect(200);

      const response = await request(server())
        .get('/customer-tags')
        .set(...auth(tenant.accessToken))
        .expect(200);

      expect((response.body as TagResponse[])[0].customerCount).toBe(1);
    });

    /** Un cliente dado de baja no puede seguir inflando el conteo. */
    it('deja de contar a los clientes dados de baja', async () => {
      const customer = await createCustomer();
      const vip = await createTag();

      await request(server())
        .put(`/customers/${customer.id}/tags`)
        .set(...auth(tenant.accessToken))
        .send({ tagIds: [vip.id] })
        .expect(200);

      await request(server())
        .delete(`/customers/${customer.id}`)
        .set(...auth(tenant.accessToken))
        .expect(204);

      const response = await request(server())
        .get('/customer-tags')
        .set(...auth(tenant.accessToken))
        .expect(200);

      expect((response.body as TagResponse[])[0].customerCount).toBe(0);
    });

    it('dar de baja una etiqueta la saca de los clientes que la tenían', async () => {
      const customer = await createCustomer();
      const vip = await createTag();

      await request(server())
        .put(`/customers/${customer.id}/tags`)
        .set(...auth(tenant.accessToken))
        .send({ tagIds: [vip.id] })
        .expect(200);

      await request(server())
        .delete(`/customer-tags/${vip.id}`)
        .set(...auth(tenant.accessToken))
        .expect(204);

      const response = await request(server())
        .get(`/customers/${customer.id}`)
        .set(...auth(tenant.accessToken))
        .expect(200);

      expect((response.body as CustomerResponse).tags).toEqual([]);
    });

    it('rechaza etiquetas repetidas en la misma lista', async () => {
      const customer = await createCustomer();
      const vip = await createTag();

      await request(server())
        .put(`/customers/${customer.id}/tags`)
        .set(...auth(tenant.accessToken))
        .send({ tagIds: [vip.id, vip.id] })
        .expect(400);
    });

    it('rechaza una etiqueta de otro negocio', async () => {
      const customer = await createCustomer();
      const otro = await registerTenant(app, 'Otro Negocio');

      const ajena = await request(server())
        .post('/customer-tags')
        .set(...auth(otro.accessToken))
        .send({ name: 'Ajena' })
        .expect(201);

      await request(server())
        .put(`/customers/${customer.id}/tags`)
        .set(...auth(tenant.accessToken))
        .send({ tagIds: [(ajena.body as TagResponse).id] })
        .expect(400);
    });
  });

  describe('Permisos', () => {
    it('un profesional puede cargar y editar clientes', async () => {
      const profesional = await createProfessional();

      const customer = await createCustomer({}, profesional);

      await request(server())
        .patch(`/customers/${customer.id}`)
        .set(...auth(profesional))
        .send({ notes: 'Vino sin turno' })
        .expect(200);
    });

    /** Sacar una ficha de circulación sí es cosa de quien manda. */
    it('un profesional no puede dar de baja un cliente', async () => {
      const profesional = await createProfessional();
      const customer = await createCustomer();

      await request(server())
        .delete(`/customers/${customer.id}`)
        .set(...auth(profesional))
        .expect(403);
    });

    it('un profesional no puede crear etiquetas', async () => {
      const profesional = await createProfessional();

      await request(server())
        .post('/customer-tags')
        .set(...auth(profesional))
        .send({ name: 'VIP' })
        .expect(403);
    });

    it('sin token no se llega a ningún lado', async () => {
      await request(server()).get('/customers').expect(401);
    });
  });

  describe('Aislamiento entre negocios', () => {
    it('404 al leer un cliente de otro negocio', async () => {
      const customer = await createCustomer();
      const otro = await registerTenant(app, 'Otro Negocio');

      await request(server())
        .get(`/customers/${customer.id}`)
        .set(...auth(otro.accessToken))
        .expect(404);
    });

    it('404 al editar un cliente de otro negocio', async () => {
      const customer = await createCustomer();
      const otro = await registerTenant(app, 'Otro Negocio');

      await request(server())
        .patch(`/customers/${customer.id}`)
        .set(...auth(otro.accessToken))
        .send({ firstName: 'Robada' })
        .expect(404);
    });
  });
});
