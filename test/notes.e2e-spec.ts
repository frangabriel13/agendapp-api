import { randomUUID } from 'node:crypto';
import { NoteEntityType } from '@prisma/client';
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

const EMPLOYEE_PASSWORD = 'claveNueva123';

interface NoteBody {
  id: string;
  author: { id: string; firstName: string; lastName: string };
  content: string;
  isPrivate: boolean;
  entityType: NoteEntityType;
  entityId: string | null;
}

interface PaginatedNotes {
  data: NoteBody[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
}

describe('Notas internas (e2e)', () => {
  let app: TestApp;
  let prisma: PrismaService;
  let tenant: RegisteredTenant;
  let customerId: string;

  /** Dos profesionales distintos: la privacidad no se prueba con uno solo. */
  let luciaToken: string;
  let anaToken: string;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();
  const asOwner = () => auth(tenant.accessToken);

  async function createProfessional(firstName: string): Promise<string> {
    const email = `${randomUUID()}@e2e.test`;

    const invitation = await request(server())
      .post('/employees')
      .set(...asOwner())
      .send({ email, firstName, lastName: 'Fernández', role: 'PROFESSIONAL' })
      .expect(201);

    const { activationUrl } = invitation.body as { activationUrl: string };

    await request(server())
      .post('/employees/activate')
      .send({
        token: new URL(activationUrl).searchParams.get('token'),
        password: EMPLOYEE_PASSWORD,
      })
      .expect(204);

    const login = await request(server())
      .post('/auth/login')
      .send({ email, password: EMPLOYEE_PASSWORD })
      .expect(200);

    return (login.body as { accessToken: string }).accessToken;
  }

  async function createCustomer(phone = '11 5555-1234'): Promise<string> {
    const response = await request(server())
      .post('/customers')
      .set(...asOwner())
      .send({ firstName: 'María', lastName: 'González', phone })
      .expect(201);

    return (response.body as { id: string }).id;
  }

  const post = (token: string, body: Record<string, unknown>) =>
    request(server())
      .post('/notes')
      .set(...auth(token))
      .send(body);

  const list = (token: string, query: Record<string, string> = {}) =>
    request(server())
      .get('/notes')
      .set(...auth(token))
      .query(query);

  /** Una nota sobre el cliente de siempre, del autor que se le pase. */
  const noteOnCustomer = (token: string, extra: Record<string, unknown> = {}) =>
    post(token, {
      entityType: NoteEntityType.CUSTOMER,
      entityId: customerId,
      content: 'Vino con el pelo teñido en casa',
      ...extra,
    });

  beforeEach(async () => {
    await resetDatabase(prisma);
    tenant = await registerTenant(app, 'Peluquería Ana');
    await switchPlan(prisma, tenant.tenantId, 'avanzado');
    customerId = await createCustomer();
    luciaToken = await createProfessional('Lucía');
    anaToken = await createProfessional('Ana');
  });

  // ── Escribir ──────────────────────────────────────────────────────────────

  it('anota sobre un cliente y guarda quién la escribió', async () => {
    const response = await noteOnCustomer(luciaToken).expect(201);
    const body = response.body as NoteBody;

    expect(body.entityType).toBe(NoteEntityType.CUSTOMER);
    expect(body.entityId).toBe(customerId);
    expect(body.isPrivate).toBe(false);
    expect(body.author.firstName).toBe('Lucía');
  });

  it('la nota del negocio va sin entidad', async () => {
    const response = await post(luciaToken, {
      entityType: NoteEntityType.GENERAL,
      content: 'La semana que viene cerramos el martes',
    }).expect(201);

    expect((response.body as NoteBody).entityId).toBeNull();
  });

  /**
   * Las dos mitades de la misma regla. La de abajo es la que se olvida: mandar
   * un `entityId` con `GENERAL` pasaría la validación de tipos y rebotaría
   * contra el CHECK de la base con un error incomprensible.
   */
  it('un tipo con entidad exige el id', async () => {
    await post(luciaToken, {
      entityType: NoteEntityType.CUSTOMER,
      content: 'Sin destino',
    }).expect(400);
  });

  it('la nota del negocio rechaza un id', async () => {
    await post(luciaToken, {
      entityType: NoteEntityType.GENERAL,
      entityId: customerId,
      content: 'General pero con destino',
    }).expect(400);
  });

  /** Sin FK, esta consulta es la única garantía de que el destino existe. */
  it('una entidad inexistente es 400 y no una nota huérfana', async () => {
    await post(luciaToken, {
      entityType: NoteEntityType.CUSTOMER,
      entityId: randomUUID(),
      content: 'Sobre nadie',
    }).expect(400);

    expect(await prisma.note.count()).toBe(0);
  });

  it('no se puede anotar sobre el cliente de otro negocio', async () => {
    const otro = await registerTenant(app, 'Peluquería Beto');

    const ajeno = await request(server())
      .post('/customers')
      .set(...auth(otro.accessToken))
      .send({ firstName: 'Ajena', phone: '11 9999-0000' })
      .expect(201);

    await post(luciaToken, {
      entityType: NoteEntityType.CUSTOMER,
      entityId: (ajeno.body as { id: string }).id,
      content: 'Espiando',
    }).expect(400);
  });

  it('una nota vacía no es una nota', async () => {
    await noteOnCustomer(luciaToken, { content: '   ' }).expect(400);
  });

  // ── Leer ──────────────────────────────────────────────────────────────────

  it('lista las de una entidad, de la más nueva', async () => {
    await noteOnCustomer(luciaToken, { content: 'Primera' }).expect(201);
    await noteOnCustomer(luciaToken, { content: 'Segunda' }).expect(201);

    const otroCliente = await createCustomer('11 7777-8888');
    await post(luciaToken, {
      entityType: NoteEntityType.CUSTOMER,
      entityId: otroCliente,
      content: 'De otra persona',
    }).expect(201);

    const response = await list(luciaToken, {
      entityType: NoteEntityType.CUSTOMER,
      entityId: customerId,
    }).expect(200);

    const body = response.body as PaginatedNotes;

    expect(body.meta.total).toBe(2);
    expect(body.data.map((note) => note.content)).toEqual([
      'Segunda',
      'Primera',
    ]);
  });

  it('filtrar por entidad sin decir de qué tipo es 400', async () => {
    await list(luciaToken, { entityId: customerId }).expect(400);
  });

  it('las notas de otro negocio no se ven', async () => {
    await noteOnCustomer(luciaToken).expect(201);

    const otro = await registerTenant(app, 'Peluquería Beto');
    const response = await list(otro.accessToken).expect(200);

    expect((response.body as PaginatedNotes).meta.total).toBe(0);
  });

  // ── Privacidad ────────────────────────────────────────────────────────────

  /**
   * ⚠️ El corazón de `isPrivate`. La nota ajena y privada **no aparece
   * marcada ni recortada: no está**. Si apareciera, "privada" sería una
   * palabra que miente en la pantalla.
   */
  it('la nota privada de otro no aparece en el listado', async () => {
    await noteOnCustomer(luciaToken, {
      content: 'Reservado',
      isPrivate: true,
    }).expect(201);

    const response = await list(anaToken).expect(200);

    expect((response.body as PaginatedNotes).meta.total).toBe(0);
  });

  it('la propia sí, aunque sea privada', async () => {
    await noteOnCustomer(luciaToken, {
      content: 'Reservado',
      isPrivate: true,
    }).expect(201);

    const response = await list(luciaToken).expect(200);

    expect((response.body as PaginatedNotes).meta.total).toBe(1);
  });

  /** El dueño responde por lo que se escribe en su negocio: las ve todas. */
  it('el dueño ve las privadas de todos', async () => {
    await noteOnCustomer(luciaToken, {
      content: 'Reservado',
      isPrivate: true,
    }).expect(201);

    const response = await list(tenant.accessToken).expect(200);

    expect((response.body as PaginatedNotes).meta.total).toBe(1);
  });

  it('una privada ajena es 404 y no 403: un 403 confirmaría que existe', async () => {
    const nota = await noteOnCustomer(luciaToken, {
      content: 'Reservado',
      isPrivate: true,
    }).expect(201);

    const { id } = nota.body as NoteBody;

    await request(server())
      .get(`/notes/${id}`)
      .set(...auth(anaToken))
      .expect(404);
  });

  // ── Editar y borrar ───────────────────────────────────────────────────────

  it('el autor edita la suya', async () => {
    const nota = await noteOnCustomer(luciaToken).expect(201);

    const response = await request(server())
      .patch(`/notes/${(nota.body as NoteBody).id}`)
      .set(...auth(luciaToken))
      .send({ content: 'Corregido', isPrivate: true })
      .expect(200);

    expect((response.body as NoteBody).content).toBe('Corregido');
    expect((response.body as NoteBody).isPrivate).toBe(true);
  });

  it('otro profesional no puede editar una nota pública ajena', async () => {
    const nota = await noteOnCustomer(luciaToken).expect(201);

    await request(server())
      .patch(`/notes/${(nota.body as NoteBody).id}`)
      .set(...auth(anaToken))
      .send({ content: 'Me la apropio' })
      .expect(403);
  });

  it('el dueño sí', async () => {
    const nota = await noteOnCustomer(luciaToken).expect(201);

    await request(server())
      .patch(`/notes/${(nota.body as NoteBody).id}`)
      .set(...asOwner())
      .send({ content: 'Moderada' })
      .expect(200);
  });

  it('borrar la saca del listado sin perder la fila', async () => {
    const nota = await noteOnCustomer(luciaToken).expect(201);
    const { id } = nota.body as NoteBody;

    await request(server())
      .delete(`/notes/${id}`)
      .set(...auth(luciaToken))
      .expect(204);

    const response = await list(luciaToken).expect(200);
    expect((response.body as PaginatedNotes).meta.total).toBe(0);

    const row = await prisma.note.findUniqueOrThrow({
      where: { id },
      select: { deletedAt: true },
    });

    expect(row.deletedAt).not.toBeNull();
  });

  it('otro profesional no puede borrar la ajena', async () => {
    const nota = await noteOnCustomer(luciaToken).expect(201);

    await request(server())
      .delete(`/notes/${(nota.body as NoteBody).id}`)
      .set(...auth(anaToken))
      .expect(403);
  });

  // ── Paginación ────────────────────────────────────────────────────────────

  it('pagina', async () => {
    for (const content of ['A', 'B', 'C']) {
      await noteOnCustomer(luciaToken, { content }).expect(201);
    }

    const response = await list(luciaToken, {
      page: '2',
      pageSize: '2',
    }).expect(200);

    const body = response.body as PaginatedNotes;

    expect(body.meta).toMatchObject({ page: 2, total: 3, totalPages: 2 });
    expect(body.data).toHaveLength(1);
  });
});
