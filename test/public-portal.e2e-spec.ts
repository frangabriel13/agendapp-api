import { randomUUID } from 'node:crypto';
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
} from './utils/e2e-app';

interface BusinessBody {
  slug: string;
  displayName: string;
  description: string | null;
  logoUrl: string | null;
  primaryColor: string | null;
  timezone: string;
  currency: string;
  language: string;
  booking: {
    enabled: boolean;
    minNoticeMinutes: number;
    maxDaysAhead: number;
    depositRequired: boolean;
    cancellationPolicyHours: number;
  };
}

interface BranchBody {
  id: string;
  name: string;
  address: string | null;
  phone: string | null;
  businessHours: {
    dayOfWeek: number;
    isClosed: boolean;
    opensAt: string | null;
    closesAt: string | null;
  }[];
}

interface ServiceGroupBody {
  id: string | null;
  name: string;
  services: {
    id: string;
    name: string;
    durationMinutes: number;
    priceCents: number;
    depositAmountCents: number | null;
  }[];
}

describe('Portal público (e2e)', () => {
  let app: TestApp;
  let prisma: PrismaService;
  let tenant: RegisteredTenant;
  let slug: string;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();

  /** Sin `Authorization`: es el punto de todo este archivo. */
  const portal = (path = '') => request(server()).get(`/public/${slug}${path}`);

  async function slugOf(tenantId: string): Promise<string> {
    const row = await prisma.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: { slug: true },
    });

    return row.slug;
  }

  async function createBranch(
    name: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const response = await request(server())
      .post('/branches')
      .set(...auth(tenant.accessToken))
      .send({ name, ...extra })
      .expect(201);

    return (response.body as { id: string }).id;
  }

  async function createService(body: Record<string, unknown>): Promise<string> {
    const response = await request(server())
      .post('/services')
      .set(...auth(tenant.accessToken))
      .send({ durationMinutes: 45, priceCents: 100_000, ...body })
      .expect(201);

    return (response.body as { id: string }).id;
  }

  beforeEach(async () => {
    await resetDatabase(prisma);
    tenant = await registerTenant(app, 'Peluquería Ana');
    await switchPlan(prisma, tenant.tenantId, 'avanzado');
    slug = await slugOf(tenant.tenantId);
  });

  // ── El negocio ────────────────────────────────────────────────────────────

  it('un desconocido ve el negocio sin ningún token', async () => {
    const response = await portal().expect(200);
    const body = response.body as BusinessBody;

    expect(body).toMatchObject({
      slug,
      displayName: 'Peluquería Ana',
      timezone: 'America/Argentina/Buenos_Aires',
      currency: 'ARS',
    });
  });

  /**
   * El portal pinta horarios que viajan en UTC. Sin la zona del negocio los
   * muestra en la del visitante, que puede estar en otro huso.
   */
  it('la zona horaria del negocio viene siempre', async () => {
    await prisma.tenant.update({
      where: { id: tenant.tenantId },
      data: { timezone: 'America/Santiago' },
    });

    const response = await portal().expect(200);

    expect((response.body as BusinessBody).timezone).toBe('America/Santiago');
  });

  it('publica las reglas de reserva para que el calendario no adivine', async () => {
    await request(server())
      .patch('/tenants/me/settings')
      .set(...auth(tenant.accessToken))
      .send({ minBookingNoticeMinutes: 180, maxBookingDaysAhead: 30 })
      .expect(200);

    const response = await portal().expect(200);

    expect((response.body as BusinessBody).booking).toMatchObject({
      enabled: true,
      minNoticeMinutes: 180,
      maxDaysAhead: 30,
      // Constante en el portal: no la mueve `requireDepositForBooking`.
      depositRequired: true,
    });
  });

  /**
   * Apagar las reservas **no apaga la página**: el negocio que se llenó el mes
   * quiere dejar de tomar turnos sin que se le caiga la URL que compartió.
   */
  it('con las reservas apagadas el portal se sigue viendo', async () => {
    await createService({ name: 'Corte' });

    await request(server())
      .patch('/tenants/me/settings')
      .set(...auth(tenant.accessToken))
      .send({ publicBookingEnabled: false })
      .expect(200);

    const response = await portal().expect(200);
    expect((response.body as BusinessBody).booking.enabled).toBe(false);

    // Y los servicios siguen ahí: es una vidriera, no un candado.
    const servicios = await portal('/services').expect(200);
    expect(servicios.body).toHaveLength(1);
  });

  /** Lo que sale acá es la vidriera, no la ficha interna del negocio. */
  it('no filtra nada del panel', async () => {
    const response = await portal().expect(200);
    const crudo = JSON.stringify(response.body);

    for (const interno of [
      'planId',
      'subscriptionStatus',
      'trialEndsAt',
      'ownerUserId',
      tenant.email,
      tenant.tenantId,
    ]) {
      expect(crudo).not.toContain(interno);
    }
  });

  // ── Slug ──────────────────────────────────────────────────────────────────

  it('un slug que no existe es 404', async () => {
    await request(server()).get('/public/no-existe-este-negocio').expect(404);
  });

  /**
   * Mismo mensaje que "no existe": si no, se puede averiguar qué slugs hubo.
   *
   * **Y tiene que dar 404 en las tres rutas, no solo en la raíz.** El corte lo
   * hace el `deletedAt` del guard: la extension de soft delete filtra el borrado
   * de *cada fila*, no el del negocio dueño, así que sin ese chequeo el
   * catálogo de un negocio dado de baja se seguiría viendo entero. Probarlo
   * solo contra `GET /public/:slug` no lo detecta —ahí el 404 sale igual por
   * otro camino— y por eso el test recorre las tres.
   */
  it('un negocio borrado es 404 en todo el portal', async () => {
    await createBranch('Sucursal Centro');
    await createService({ name: 'Corte' });

    await prisma.tenant.update({
      where: { id: tenant.tenantId },
      data: { deletedAt: new Date() },
    });

    await portal('/services').expect(404);
    await portal('/branches').expect(404);

    const borrado = await portal().expect(404);
    const inexistente = await request(server())
      .get('/public/no-existe-este-negocio')
      .expect(404);

    expect((borrado.body as { message: string }).message).toBe(
      (inexistente.body as { message: string }).message,
    );
  });

  /**
   * El portal usa `prisma.scoped` con el tenant que montó el guard, así que el
   * aislamiento es el mismo de siempre. Esto lo fija por las dudas: es el error
   * que convertiría el portal en una fuga de datos de todos los negocios.
   */
  it('el portal de un negocio no muestra nada del otro', async () => {
    await createService({ name: 'Corte de Ana' });

    const otro = await registerTenant(app, 'Barbería Bruno');
    await switchPlan(prisma, otro.tenantId, 'avanzado');

    await request(server())
      .post('/services')
      .set(...auth(otro.accessToken))
      .send({ name: 'Corte de Bruno', durationMinutes: 30, priceCents: 50_000 })
      .expect(201);

    const deAna = await portal('/services').expect(200);
    const nombres = (deAna.body as ServiceGroupBody[]).flatMap((group) =>
      group.services.map((service) => service.name),
    );

    expect(nombres).toEqual(['Corte de Ana']);
  });

  // ── Sucursales ────────────────────────────────────────────────────────────

  it('trae las sucursales activas con su horario de atención', async () => {
    const centro = await createBranch('Sucursal Centro', {
      address: 'Corrientes 1234',
      phone: '11 5555-1234',
    });

    await request(server())
      .put(`/branches/${centro}/business-hours`)
      .set(...auth(tenant.accessToken))
      .send({
        // El set es semanal completo: el domingo cerrado y el resto abierto.
        days: Array.from({ length: 7 }, (_, dayOfWeek) =>
          dayOfWeek === 0
            ? { dayOfWeek, isClosed: true }
            : { dayOfWeek, opensAt: '09:00', closesAt: '18:00' },
        ),
      })
      .expect(200);

    const response = await portal('/branches').expect(200);
    const [sucursal] = response.body as BranchBody[];

    expect(sucursal).toMatchObject({
      name: 'Sucursal Centro',
      address: 'Corrientes 1234',
      phone: '11 5555-1234',
    });
    expect(sucursal.businessHours).toEqual(
      expect.arrayContaining([
        { dayOfWeek: 1, isClosed: false, opensAt: '09:00', closesAt: '18:00' },
        { dayOfWeek: 0, isClosed: true, opensAt: null, closesAt: null },
      ]),
    );
  });

  it('una sucursal inactiva no aparece', async () => {
    const centro = await createBranch('Sucursal Centro');
    await createBranch('Sucursal Palermo');

    await request(server())
      .patch(`/branches/${centro}`)
      .set(...auth(tenant.accessToken))
      .send({ isActive: false })
      .expect(200);

    const response = await portal('/branches').expect(200);

    expect((response.body as BranchBody[]).map((row) => row.name)).toEqual([
      'Sucursal Palermo',
    ]);
  });

  // ── Servicios ─────────────────────────────────────────────────────────────

  /**
   * `isActive` y `publiclyBookable` son dos condiciones distintas, y esta es la
   * razón de que el campo exista: un retoque de garantía se agenda desde el
   * panel, no lo elige un desconocido de una lista.
   */
  it('un servicio activo pero no público no aparece', async () => {
    await createService({ name: 'Corte' });
    const interno = await createService({ name: 'Retoque de garantía' });

    await request(server())
      .patch(`/services/${interno}`)
      .set(...auth(tenant.accessToken))
      .send({ publiclyBookable: false })
      .expect(200);

    const response = await portal('/services').expect(200);
    const nombres = (response.body as ServiceGroupBody[]).flatMap((group) =>
      group.services.map((service) => service.name),
    );

    expect(nombres).toEqual(['Corte']);

    // Y sigue existiendo para el panel, que es todo el punto.
    const panel = await request(server())
      .get('/services')
      .set(...auth(tenant.accessToken))
      .expect(200);
    expect(panel.body).toHaveLength(2);
  });

  it('un servicio inactivo tampoco aparece', async () => {
    const corte = await createService({ name: 'Corte' });

    await request(server())
      .patch(`/services/${corte}`)
      .set(...auth(tenant.accessToken))
      .send({ isActive: false })
      .expect(200);

    expect(await portal('/services').expect(200)).toMatchObject({ body: [] });
  });

  it('agrupa por categoría respetando el orden de la categoría', async () => {
    const categoria = async (name: string, displayOrder: number) => {
      const response = await request(server())
        .post('/service-categories')
        .set(...auth(tenant.accessToken))
        .send({ name, displayOrder })
        .expect(201);

      return (response.body as { id: string }).id;
    };

    const color = await categoria('Color', 1);
    const corte = await categoria('Corte', 2);

    await createService({ name: 'Mechas', categoryId: color });
    await createService({ name: 'Corte de dama', categoryId: corte });
    // Sin categoría: va al final, y NO se esconde.
    await createService({ name: 'Peinado' });

    const response = await portal('/services').expect(200);
    const grupos = response.body as ServiceGroupBody[];

    expect(grupos.map((group) => group.name)).toEqual([
      'Color',
      'Corte',
      'Otros',
    ]);
    expect(grupos[2]).toMatchObject({
      id: null,
      services: [{ name: 'Peinado' }],
    });
  });

  it('publica la seña de cada servicio, que es lo que se va a cobrar', async () => {
    await createService({
      name: 'Color',
      priceCents: 200_000,
      depositAmountCents: 50_000,
    });

    const response = await portal('/services').expect(200);
    const [grupo] = response.body as ServiceGroupBody[];

    expect(grupo.services[0]).toMatchObject({
      priceCents: 200_000,
      depositAmountCents: 50_000,
    });
  });

  it('un negocio sin servicios públicos devuelve una lista vacía, no un error', async () => {
    expect(await portal('/services').expect(200)).toMatchObject({ body: [] });
    expect(await portal('/branches').expect(200)).toMatchObject({ body: [] });
  });

  /** El portal no es una puerta de atrás a los endpoints del panel. */
  it('el slug no abre nada del panel', async () => {
    await request(server()).get('/services').expect(401);
    await request(server()).get(`/public/${randomUUID()}`).expect(404);
  });
});
