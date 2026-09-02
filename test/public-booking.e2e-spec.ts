import { randomUUID } from 'node:crypto';
import { AppointmentSource, AppointmentStatus } from '@prisma/client';
import request from 'supertest';
import { AppointmentsService } from '../src/modules/appointments/appointments.service';
import { SubscriptionsService } from '../src/modules/subscriptions/subscriptions.service';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { RecordingMailProvider } from './utils/recording-mail.provider';
import {
  auth,
  createTestApp,
  registerTenant,
  resetDatabase,
  switchPlan,
  type RegisteredTenant,
  type TestApp,
} from './utils/e2e-app';

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

/** El seed deja el negocio en Buenos Aires, que es UTC-3 todo el año. */
const BA_OFFSET_HOURS = 3;

/** El default de `SUBSCRIPTION_GRACE_DAYS`. */
const GRACE_DAYS = 7;

/**
 * Las fechas se calculan **contra el reloj**, no fijas como en el resto de los
 * e2e. Acá es obligatorio: lo que se prueba es la ventana de reserva, que es
 * relativa a "ahora" — una fecha escrita a mano haría pasar los tests hoy y
 * fallar solos el día que el calendario la deje afuera.
 */
function businessDate(daysAhead: number): string {
  const instant = new Date(
    Date.now() - BA_OFFSET_HOURS * 60 * 60 * 1_000 + daysAhead * MS_PER_DAY,
  );

  return instant.toISOString().slice(0, 10);
}

/** `"09:00"` de ese día en Buenos Aires, como instante ISO. */
function at(dateOnly: string, hhmm: string): string {
  const [hours, minutes] = hhmm.split(':').map(Number);

  return `${dateOnly}T${String(hours + BA_OFFSET_HOURS).padStart(2, '0')}:${String(
    minutes,
  ).padStart(2, '0')}:00.000Z`;
}

interface AvailabilityBody {
  slots: {
    startsAt: string;
    endsAt: string;
    employees: { employeeId: string; employeeName: string }[];
  }[];
}

interface BookingBody {
  appointmentId: string;
  startsAt: string;
  endsAt: string;
  status: string;
  branchName: string;
  employeeName: string;
  services: { id: string; name: string; priceCents: number }[];
  totalPriceCents: number;
  currency: string;
  deposit: {
    amountCents: number;
    currency: string;
    checkoutUrl: string;
  } | null;
}

describe('Reserva pública (e2e)', () => {
  let app: TestApp;
  let prisma: PrismaService;
  let mail: RecordingMailProvider;
  let tenant: RegisteredTenant;
  let slug: string;
  let branchId: string;
  let serviceId: string;
  let employeeId: string;

  /** El día contra el que se reserva: lejos del piso y dentro del techo. */
  const DAY = businessDate(7);

  beforeAll(async () => {
    ({ app, prisma, mail } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();
  const asOwner = () => auth(tenant.accessToken);

  // ── Setup ─────────────────────────────────────────────────────────────────

  async function createBranch(name = 'Sucursal Centro'): Promise<string> {
    const response = await request(server())
      .post('/branches')
      .set(...asOwner())
      .send({ name, address: 'Av. Corrientes 1234', phone: '11 4444-5555' })
      .expect(201);

    const id = (response.body as { id: string }).id;

    // Abierta todos los días: qué día de la semana cae `DAY` depende de cuándo
    // corran los tests, y no es lo que se está probando.
    await request(server())
      .put(`/branches/${id}/business-hours`)
      .set(...asOwner())
      .send({
        days: Array.from({ length: 7 }, (_, dayOfWeek) => ({
          dayOfWeek,
          opensAt: '09:00',
          closesAt: '18:00',
        })),
      })
      .expect(200);

    return id;
  }

  async function createService(
    body: Record<string, unknown> = {},
  ): Promise<string> {
    const response = await request(server())
      .post('/services')
      .set(...asOwner())
      .send({
        name: `Corte ${randomUUID().slice(0, 8)}`,
        durationMinutes: 60,
        priceCents: 100_000,
        ...body,
      })
      .expect(201);

    return (response.body as { id: string }).id;
  }

  async function createProfessional(
    firstName = 'Lucía',
    shift = { startsAt: '09:00', endsAt: '13:00' },
  ): Promise<string> {
    const invitation = await request(server())
      .post('/employees')
      .set(...asOwner())
      .send({
        email: `${randomUUID()}@e2e.test`,
        firstName,
        lastName: 'Fernández',
        role: 'PROFESSIONAL',
        branchIds: [branchId],
      })
      .expect(201);

    const body = invitation.body as {
      employee: { id: string };
      activationUrl: string;
    };

    const token = new URL(body.activationUrl).searchParams.get('token');

    await request(server())
      .post('/employees/activate')
      .send({ token, password: 'claveNueva123' })
      .expect(204);

    await request(server())
      .put(`/employees/${body.employee.id}/schedules`)
      .set(...asOwner())
      .send({
        shifts: Array.from({ length: 7 }, (_, dayOfWeek) => ({
          ...shift,
          branchId,
          dayOfWeek,
        })),
      })
      .expect(200);

    return body.employee.id;
  }

  async function assign(service: string, employees: string[]): Promise<void> {
    await request(server())
      .put(`/services/${service}/employees`)
      .set(...asOwner())
      .send({
        assignments: employees.map((id) => ({ employeeId: id, branchId })),
      })
      .expect(200);
  }

  async function updateSettings(body: Record<string, unknown>): Promise<void> {
    await request(server())
      .patch('/tenants/me/settings')
      .set(...asOwner())
      .send(body)
      .expect(200);
  }

  // ── Los dos endpoints, sin ningún token ───────────────────────────────────

  const availability = (query: Record<string, string> = {}) =>
    request(server())
      .get(`/public/${slug}/availability`)
      .query({ branchId, serviceIds: serviceId, date: DAY, ...query });

  const book = (body: Record<string, unknown> = {}) =>
    request(server())
      .post(`/public/${slug}/appointments`)
      .send({
        branchId,
        serviceIds: [serviceId],
        startsAt: at(DAY, '09:00'),
        customer: { firstName: 'María', phone: '11 5555-1234' },
        ...body,
      });

  beforeEach(async () => {
    await resetDatabase(prisma);
    mail.clear();
    tenant = await registerTenant(app, 'Peluquería Ana');
    await switchPlan(prisma, tenant.tenantId, 'avanzado');

    const row = await prisma.tenant.findUniqueOrThrow({
      where: { id: tenant.tenantId },
      select: { slug: true },
    });

    slug = row.slug;
    branchId = await createBranch();
    serviceId = await createService();
    employeeId = await createProfessional();
    await assign(serviceId, [employeeId]);
  });

  // ── Disponibilidad ────────────────────────────────────────────────────────

  it('un desconocido ve los horarios libres sin ningún token', async () => {
    const response = await availability().expect(200);
    const body = response.body as AvailabilityBody;

    expect(body.slots).toHaveLength(4); // 09, 10, 11 y 12
    expect(body.slots[0].startsAt).toBe(at(DAY, '09:00'));
    expect(body.slots[0].employees[0].employeeId).toBe(employeeId);
  });

  /**
   * El piso de la ventana. Se prueba subiéndolo por encima del día pedido en
   * vez de reservar "para dentro de un rato": así el test no depende de a qué
   * hora del día se corra.
   */
  it('no ofrece nada antes de la antelación mínima', async () => {
    await updateSettings({ minBookingNoticeMinutes: 30 * 24 * 60 });

    const response = await availability().expect(200);

    expect((response.body as AvailabilityBody).slots).toHaveLength(0);
  });

  it('no ofrece nada después del último día reservable', async () => {
    await updateSettings({ maxBookingDaysAhead: 3 });

    const lejos = await availability().expect(200);
    expect((lejos.body as AvailabilityBody).slots).toHaveLength(0);

    const cerca = await availability({ date: businessDate(2) }).expect(200);
    expect((cerca.body as AvailabilityBody).slots.length).toBeGreaterThan(0);
  });

  /** El último día permitido entra entero: el borde es "hasta", no "antes de". */
  it('el último día reservable todavía tiene horarios', async () => {
    await updateSettings({ maxBookingDaysAhead: 7 });

    const response = await availability().expect(200);

    expect((response.body as AvailabilityBody).slots.length).toBeGreaterThan(0);
  });

  it('con las reservas apagadas no muestra horarios: 403', async () => {
    await updateSettings({ publicBookingEnabled: false });

    await availability().expect(403);
  });

  // ── Reservar ──────────────────────────────────────────────────────────────

  it('reserva sin token y el turno queda confirmado', async () => {
    const response = await book().expect(201);
    const body = response.body as BookingBody;

    expect(body.status).toBe(AppointmentStatus.CONFIRMED);
    expect(body.deposit).toBeNull();
    expect(body.startsAt).toBe(at(DAY, '09:00'));
    expect(body.employeeName).toContain('Lucía');
    expect(body.branchName).toBe('Sucursal Centro');
    expect(body.totalPriceCents).toBe(100_000);

    const saved = await prisma.appointment.findUniqueOrThrow({
      where: { id: body.appointmentId },
      select: { createdVia: true, createdByUserId: true },
    });

    expect(saved.createdVia).toBe(AppointmentSource.PUBLIC_BOOKING);
    // La columna era nullable y el método no lo era: esto es lo que se abrió.
    expect(saved.createdByUserId).toBeNull();
  });

  it('el hueco queda ocupado: ya no se ofrece', async () => {
    await book().expect(201);

    const response = await availability().expect(200);
    const horas = (response.body as AvailabilityBody).slots.map(
      (slot) => slot.startsAt,
    );

    expect(horas).not.toContain(at(DAY, '09:00'));
    expect(horas).toHaveLength(3);
  });

  it('dos reservas al mismo horario: la segunda es 409', async () => {
    await book().expect(201);

    await book({
      customer: { firstName: 'Ana', phone: '11 5555-9999' },
    }).expect(409);
  });

  it('un horario que no está en la grilla es 409, no un turno torcido', async () => {
    await book({ startsAt: at(DAY, '09:30') }).expect(409);
  });

  /**
   * La ventana se aplica también al alta y no solo a la consulta. Sin esto,
   * saltearse el portal y postear directo agenda para dentro de dos años.
   */
  it('un horario fuera de la ventana es 409 aunque el hueco esté libre', async () => {
    await updateSettings({ maxBookingDaysAhead: 3 });

    await book().expect(409);
  });

  it('con las reservas apagadas no se puede reservar: 403', async () => {
    await updateSettings({ publicBookingEnabled: false });

    await book().expect(403);
  });

  // ── La seña ───────────────────────────────────────────────────────────────

  /**
   * ⚠️ El test que fija la decisión 3. `requireDepositForBooking` queda en
   * `false` —su default, el del mostrador— y el turno del portal **igual**
   * nace esperando el pago. Si alguien "unifica" las dos reglas, esto rompe.
   */
  it('la seña se espera siempre, aunque el mostrador no la exija', async () => {
    const conSeña = await createService({ depositAmountCents: 30_000 });
    await assign(conSeña, [employeeId]);

    const settings = await prisma.tenantSettings.findFirstOrThrow({
      where: { tenantId: tenant.tenantId },
      select: { requireDepositForBooking: true },
    });

    expect(settings.requireDepositForBooking).toBe(false);

    const response = await book({ serviceIds: [conSeña] }).expect(201);
    const body = response.body as BookingBody;

    expect(body.status).toBe(AppointmentStatus.PENDING_PAYMENT);
    expect(body.deposit?.amountCents).toBe(30_000);
    expect(body.deposit?.checkoutUrl).toContain('http');
  });

  // ── El cliente ────────────────────────────────────────────────────────────

  /**
   * El mismo teléfono es la misma persona: no se duplica la ficha. Y **la
   * respuesta no cambia**, que es lo que impide usar esto para averiguar quién
   * es clienta del negocio.
   */
  it('un teléfono ya cargado reusa la ficha sin decirlo', async () => {
    await request(server())
      .post('/customers')
      .set(...asOwner())
      .send({ firstName: 'María', lastName: 'González', phone: '11 5555-1234' })
      .expect(201);

    const response = await book().expect(201);

    expect(Object.keys(response.body as object)).not.toContain('customer');
    expect(JSON.stringify(response.body)).not.toContain('González');

    const fichas = await prisma.customer.findMany({
      where: { tenantId: tenant.tenantId },
      select: { firstName: true, lastName: true },
    });

    expect(fichas).toHaveLength(1);
    // Lo que cargó el negocio gana: un formulario anónimo no edita su ficha.
    expect(fichas[0].lastName).toBe('González');
  });

  it('un teléfono nuevo crea la ficha', async () => {
    await book({
      customer: { firstName: 'Ana', phone: '11 7777-8888' },
    }).expect(201);

    const fichas = await prisma.customer.findMany({
      where: { tenantId: tenant.tenantId },
      select: { firstName: true, phoneNormalized: true },
    });

    expect(fichas).toHaveLength(1);
    expect(fichas[0].phoneNormalized).toBe('1177778888');
  });

  it('un hueco tomado no deja clientes fantasma', async () => {
    await book().expect(201);

    await book({
      customer: { firstName: 'Ana', phone: '11 7777-8888' },
    }).expect(409);

    const fichas = await prisma.customer.count({
      where: { tenantId: tenant.tenantId },
    });

    expect(fichas).toBe(1);
  });

  // ── "Cualquiera" ──────────────────────────────────────────────────────────

  /**
   * Sin `employeeId` elige el servidor, y elige al que menos trabajo tiene ese
   * día. Tomar siempre el primero de la lista le daría todas las reservas web a
   * quien ordene primero — que es un bug que el negocio ve en un día.
   */
  it('sin profesional elegido reparte por carga del día', async () => {
    const segundo = await createProfessional('Ana');
    await assign(serviceId, [employeeId, segundo]);

    const primera = await book().expect(201);
    const segunda = await book({
      startsAt: at(DAY, '10:00'),
      customer: { firstName: 'Ana', phone: '11 5555-9999' },
    }).expect(201);

    const asignados = await prisma.appointment.findMany({
      where: {
        id: {
          in: [
            (primera.body as BookingBody).appointmentId,
            (segunda.body as BookingBody).appointmentId,
          ],
        },
      },
      select: { employeeId: true },
    });

    expect(new Set(asignados.map((row) => row.employeeId)).size).toBe(2);
  });

  it('con profesional elegido se respeta', async () => {
    const segundo = await createProfessional('Ana');
    await assign(serviceId, [employeeId, segundo]);

    const response = await book({ employeeId: segundo }).expect(201);

    const saved = await prisma.appointment.findUniqueOrThrow({
      where: { id: (response.body as BookingBody).appointmentId },
      select: { employeeId: true },
    });

    expect(saved.employeeId).toBe(segundo);
  });

  // ── Mails ─────────────────────────────────────────────────────────────────

  it('avisa a quien reservó y al negocio', async () => {
    await book({
      customer: {
        firstName: 'María',
        phone: '11 5555-1234',
        email: 'maria@cliente.test',
      },
    }).expect(201);

    const paraLaClienta = mail.lastTo('maria@cliente.test');
    expect(paraLaClienta.subject).toContain('confirmado');
    expect(paraLaClienta.text).toContain('Sucursal Centro');

    // El aviso al negocio trae el teléfono: es para lo que se abre ese mail.
    const paraElNegocio = mail.lastTo(tenant.email);
    expect(paraElNegocio.subject).toContain('María');
    expect(paraElNegocio.text).toContain('5555-1234');
  });

  it('sin email de la clienta el turno se agenda igual', async () => {
    await book().expect(201);

    expect(mail.to(tenant.email).length).toBeGreaterThan(0);
  });

  /** Un proveedor de mail caído no puede hacerle perder el turno a nadie. */
  it('si el mail falla la reserva sigue en pie', async () => {
    mail.failing(true);

    const response = await book({
      customer: {
        firstName: 'María',
        phone: '11 5555-1234',
        email: 'maria@cliente.test',
      },
    }).expect(201);

    expect((response.body as BookingBody).appointmentId).toBeDefined();
  });

  // ── Suscripción vencida ───────────────────────────────────────────────────

  /**
   * La decisión 4: el portal se ve, no se reserva. Cortarle la página pública
   * a un negocio que se atrasó castiga a su clientela, que no tiene nada que
   * ver con la cuenta.
   */
  it('con la suscripción vencida el portal se ve pero no reserva', async () => {
    const end = new Date(Date.now() - (GRACE_DAYS + 1) * MS_PER_DAY);

    await prisma.subscription.updateMany({
      where: { tenantId: tenant.tenantId },
      // Las dos puntas: un CHECK exige que el período tenga sentido.
      data: {
        currentPeriodStart: new Date(end.getTime() - 30 * MS_PER_DAY),
        currentPeriodEnd: end,
      },
    });

    // El corte mira el estado, no la fecha: sin esto la fila sigue ACTIVE y
    // no hay nada que bloquear.
    await app.get(SubscriptionsService).expireLapsed();

    await request(server()).get(`/public/${slug}`).expect(200);
    await availability().expect(200);
    await book().expect(402);
  });

  // ── La limpieza de abandonados ────────────────────────────────────────────

  describe('reservas abandonadas', () => {
    const release = (minutesFromNow: number) =>
      app
        .get(AppointmentsService)
        .releaseAbandoned(new Date(Date.now() + minutesFromNow * 60_000));

    async function reservarConSeña(): Promise<string> {
      const conSeña = await createService({ depositAmountCents: 30_000 });
      await assign(conSeña, [employeeId]);

      const response = await book({ serviceIds: [conSeña] }).expect(201);

      return (response.body as BookingBody).appointmentId;
    }

    it('libera el hueco de la que nadie pagó', async () => {
      const id = await reservarConSeña();

      expect(await release(31)).toBe(1);

      const turno = await prisma.appointment.findUniqueOrThrow({
        where: { id },
        select: { status: true, cancellationReason: true, canceledAt: true },
      });

      expect(turno.status).toBe(AppointmentStatus.CANCELED_BY_BUSINESS);
      expect(turno.cancellationReason).toContain('seña');
      expect(turno.canceledAt).not.toBeNull();

      // Lo que importaba: el horario vuelve a ofrecerse.
      const response = await availability().expect(200);
      const horas = (response.body as AvailabilityBody).slots.map(
        (slot) => slot.startsAt,
      );

      expect(horas).toContain(at(DAY, '09:00'));
    });

    /** El hold tiene que darle tiempo real a alguien a pagar. */
    it('no toca la que recién entró', async () => {
      await reservarConSeña();

      expect(await release(5)).toBe(0);
    });

    /**
     * Un `PENDING_PAYMENT` cargado desde el panel es una decisión de alguien
     * que trabaja ahí y puede estar esperando una transferencia. Cancelárselo
     * solo sería peor que el hueco.
     */
    it('no toca los del mostrador', async () => {
      const id = await reservarConSeña();

      await prisma.appointment.update({
        where: { id },
        data: { createdVia: AppointmentSource.ADMIN },
      });

      expect(await release(120)).toBe(0);
    });

    /** Correrlo dos veces no puede cancelar nada nuevo: los jobs se repiten. */
    it('es idempotente', async () => {
      await reservarConSeña();

      expect(await release(31)).toBe(1);
      expect(await release(31)).toBe(0);
    });
  });
});
