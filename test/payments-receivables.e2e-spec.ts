import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { PrismaService } from '../src/prisma/prisma.service';
import type { SandboxPaymentProvider } from '../src/modules/payments/providers/sandbox-payment.provider';
import {
  auth,
  createTestApp,
  registerTenant,
  type RegisteredTenant,
  resetDatabase,
  switchPlan,
  type TestApp,
} from './utils/e2e-app';
import {
  enHorarioDe,
  masDias,
  masMeses,
  primerDiaDelMes,
  proximoLunes,
  ultimoDiaDelMes,
} from './utils/fechas';

/** Lunes, bien adelante en el calendario. */
const LUNES = proximoLunes();
const DAY_OF_WEEK = 1;

const PRECIO = 100_000;

interface ReceivableItem {
  appointmentId: string;
  startsAt: string;
  status: string;
  customerName: string;
  customerPhone: string | null;
  employeeName: string;
  branchName: string;
  currency: string;
  totalPriceCents: number;
  paidCents: number;
  refundedCents: number;
  dueCents: number;
  depositAmountCents: number | null;
  depositCovered: boolean;
}

interface ReceivablesPage {
  data: ReceivableItem[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
  totals: {
    appointments: number;
    totalPriceCents: number;
    paidCents: number;
    dueCents: number;
  };
}

/** `"10:00"` de Buenos Aires como instante ISO, en el lunes de los tests. */
const enBuenosAires = (hhmm: string): string => enHorarioDe(LUNES, hhmm);

describe('Lo que falta cobrar (e2e)', () => {
  let app: TestApp;
  let prisma: PrismaService;
  let sandbox: SandboxPaymentProvider;
  let tenant: RegisteredTenant;
  let centroId: string;
  let palermoId: string;
  let serviceId: string;
  let luciaId: string;
  let anaId: string;
  let customerId: string;

  beforeAll(async () => {
    ({ app, prisma, payments: sandbox } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();

  // ── Armado del escenario ──────────────────────────────────────────────────

  async function createBranch(name: string): Promise<string> {
    const branch = await request(server())
      .post('/branches')
      .set(...auth(tenant.accessToken))
      .send({ name })
      .expect(201);

    const { id } = branch.body as { id: string };

    await request(server())
      .put(`/branches/${id}/business-hours`)
      .set(...auth(tenant.accessToken))
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

  async function hire(firstName: string, branchId: string): Promise<string> {
    const invitation = await request(server())
      .post('/employees')
      .set(...auth(tenant.accessToken))
      .send({
        email: `${randomUUID()}@e2e.test`,
        firstName,
        lastName: 'Fernández',
        role: 'PROFESSIONAL',
        branchIds: [branchId],
      })
      .expect(201);

    const { employee } = invitation.body as { employee: { id: string } };

    await request(server())
      .put(`/employees/${employee.id}/schedules`)
      .set(...auth(tenant.accessToken))
      .send({
        shifts: [
          {
            branchId,
            dayOfWeek: DAY_OF_WEEK,
            startsAt: '09:00',
            endsAt: '18:00',
          },
        ],
      })
      .expect(200);

    return employee.id;
  }

  async function setUpBusiness(): Promise<void> {
    centroId = await createBranch('Sucursal Centro');
    palermoId = await createBranch('Sucursal Palermo');

    const service = await request(server())
      .post('/services')
      .set(...auth(tenant.accessToken))
      .send({
        name: 'Corte y brushing',
        durationMinutes: 60,
        priceCents: PRECIO,
      })
      .expect(201);

    serviceId = (service.body as { id: string }).id;

    luciaId = await hire('Lucía', centroId);
    anaId = await hire('Ana', palermoId);

    await request(server())
      .put(`/services/${serviceId}/employees`)
      .set(...auth(tenant.accessToken))
      .send({
        assignments: [
          { employeeId: luciaId, branchId: centroId },
          { employeeId: anaId, branchId: palermoId },
        ],
      })
      .expect(200);

    const customer = await request(server())
      .post('/customers')
      .set(...auth(tenant.accessToken))
      .send({
        firstName: 'María',
        lastName: 'López',
        phone: `11 5555-${Math.floor(1000 + Math.random() * 8999)}`,
      })
      .expect(201);

    customerId = (customer.body as { id: string }).id;
  }

  async function book(
    employeeId: string,
    branchId: string,
    startsAt = '10:00',
  ): Promise<string> {
    const response = await request(server())
      .post('/appointments')
      .set(...auth(tenant.accessToken))
      .send({
        branchId,
        employeeId,
        customerId,
        serviceIds: [serviceId],
        startsAt: enBuenosAires(startsAt),
      })
      .expect(201);

    return (response.body as { id: string }).id;
  }

  /**
   * Registra un cobro a mano y lo ubica en el tiempo.
   *
   * La fecha de acreditación se pisa después de crearlo: el endpoint la pone en
   * "ahora", y estos tests necesitan cobros en días concretos para poder decir
   * algo sobre los rangos.
   */
  async function pay(
    appointmentId: string,
    amountCents: number,
    paidAt: string,
    extra: { paymentType?: string; paymentMethod?: string } = {},
  ): Promise<string> {
    const response = await request(server())
      .post(`/appointments/${appointmentId}/payments/manual`)
      .set(...auth(tenant.accessToken))
      .send({
        amountCents,
        paymentType: extra.paymentType ?? 'FULL',
        paymentMethod: extra.paymentMethod ?? 'CASH',
      })
      .expect(201);

    const { id } = response.body as { id: string };

    await prisma.appointmentPayment.update({
      where: { id },
      data: { paidAt: new Date(paidAt) },
    });

    return id;
  }

  const deuda = (query: string) =>
    request(server())
      .get(`/payments/receivables?${query}`)
      .set(...auth(tenant.accessToken));

  /** El reporte del mes en el que cae el turno de los tests. */
  async function elMes(extra = ''): Promise<ReceivablesPage> {
    const response = await deuda(
      `from=${primerDiaDelMes(LUNES)}&to=${ultimoDiaDelMes(LUNES)}${extra}`,
    ).expect(200);

    return response.body as ReceivablesPage;
  }

  /**
   * Mueve un turno en el tiempo sin pasar por las validaciones de agenda.
   *
   * Corre las dos puntas por igual: la base tiene un CHECK que exige que
   * termine después de empezar, así que mover solo `startsAt` no compila.
   */
  async function moveTo(
    appointmentId: string,
    startsAt: string,
  ): Promise<void> {
    const current = await prisma.appointment.findUniqueOrThrow({
      where: { id: appointmentId },
      select: { startsAt: true, endsAt: true },
    });

    const next = new Date(startsAt);
    const duration = current.endsAt.getTime() - current.startsAt.getTime();

    await prisma.appointment.update({
      where: { id: appointmentId },
      data: { startsAt: next, endsAt: new Date(next.getTime() + duration) },
    });
  }

  const setStatus = (appointmentId: string, status: string) =>
    request(server())
      .patch(`/appointments/${appointmentId}/status`)
      .set(...auth(tenant.accessToken))
      .send({ status })
      .expect(200);

  beforeEach(async () => {
    await resetDatabase(prisma);
    sandbox.reset();
    tenant = await registerTenant(app);
    await switchPlan(prisma, tenant.tenantId, 'avanzado');
    await setUpBusiness();
  });

  // ── Lo que devuelve ───────────────────────────────────────────────────────

  it('lista solo los turnos que deben, con los totales del rango', async () => {
    const debe = await book(luciaId, centroId, '10:00');
    await pay(debe, 30_000, enHorarioDe(LUNES, '10:00'));

    const alDia = await book(luciaId, centroId, '12:00');
    await pay(alDia, PRECIO, enHorarioDe(LUNES, '10:00'));

    const page = await elMes();

    expect(page.meta.total).toBe(1);
    expect(page.data.map((row) => row.appointmentId)).toEqual([debe]);

    expect(page.data[0]).toMatchObject({
      status: 'CONFIRMED',
      customerName: 'María López',
      employeeName: 'Lucía Fernández',
      branchName: 'Sucursal Centro',
      currency: 'ARS',
      totalPriceCents: PRECIO,
      paidCents: 30_000,
      refundedCents: 0,
      dueCents: 70_000,
    });

    // Los totales cuentan turnos con deuda, no turnos del rango.
    expect(page.totals).toEqual({
      appointments: 1,
      totalPriceCents: PRECIO,
      paidCents: 30_000,
      dueCents: 70_000,
    });
  });

  it('un turno sin ningún cobro debe todo', async () => {
    await book(luciaId, centroId);

    const page = await elMes();

    expect(page.data[0]).toMatchObject({
      paidCents: 0,
      dueCents: PRECIO,
    });
  });

  /**
   * El motivo de existir del endpoint.
   *
   * `GET /payments` filtra por `paidAt`, y una deuda no tiene fecha de
   * acreditación —si la tuviera ya no sería una deuda—. La única fecha que
   * existe es la del turno, así que un turno de este mes cobrado el que viene
   * debe en este, y uno del mes que viene no debe en este aunque su seña haya
   * entrado ahora.
   */
  it('la deuda se ubica por la fecha del turno, no por la del cobro', async () => {
    const deEsteMes = await book(luciaId, centroId, '10:00');
    await pay(deEsteMes, 20_000, enHorarioDe(masMeses(LUNES, 1), '10:00'));

    const delQueViene = await book(luciaId, centroId, '12:00');
    await pay(delQueViene, 20_000, enHorarioDe(LUNES, '10:00'));
    await moveTo(delQueViene, enHorarioDe(masMeses(LUNES, 1), '10:00'));

    const page = await elMes();

    expect(page.data.map((row) => row.appointmentId)).toEqual([deEsteMes]);
    expect(page.totals.dueCents).toBe(80_000);
  });

  it('una devolución vuelve a generar deuda', async () => {
    const turno = await book(luciaId, centroId);
    await pay(turno, PRECIO, enHorarioDe(LUNES, '10:00'));

    // Al día siguiente se le devuelven 40.000 en efectivo.
    await pay(turno, 40_000, enHorarioDe(masDias(LUNES, 1), '10:00'), {
      paymentType: 'REFUND',
    });

    const page = await elMes();

    expect(page.data[0]).toMatchObject({
      paidCents: 60_000,
      refundedCents: 40_000,
      dueCents: 40_000,
    });
  });

  // ── Qué turno debe y cuál no ──────────────────────────────────────────────

  it('un turno cancelado no debe nada', async () => {
    const turno = await book(luciaId, centroId);
    await setStatus(turno, 'CANCELED_BY_CUSTOMER');

    const page = await elMes();

    expect(page.data).toEqual([]);
    expect(page.totals.dueCents).toBe(0);
  });

  it('un NO_SHOW sigue debiendo', async () => {
    const turno = await book(luciaId, centroId);
    await setStatus(turno, 'NO_SHOW');

    const page = await elMes();

    expect(page.data.map((row) => row.appointmentId)).toEqual([turno]);
    expect(page.data[0].status).toBe('NO_SHOW');
  });

  it('un ATTENDED sin pagar sigue debiendo', async () => {
    const turno = await book(luciaId, centroId);
    await setStatus(turno, 'ATTENDED');

    const page = await elMes();

    expect(page.data[0]).toMatchObject({
      status: 'ATTENDED',
      dueCents: PRECIO,
    });
  });

  /**
   * Al reprogramar, la deuda se muda al turno nuevo. Si el viejo siguiera
   * contando, el mes cerraría con el doble de deuda de la que existe — y ese
   * error no se ve mirando una fila sola, solo mirando el total.
   */
  it('un turno reprogramado no debe: la deuda se mudó al nuevo', async () => {
    const original = await book(luciaId, centroId, '10:00');

    await request(server())
      .post(`/appointments/${original}/reschedule`)
      .set(...auth(tenant.accessToken))
      .send({ startsAt: enBuenosAires('15:00') })
      .expect(201);

    const page = await elMes();

    expect(page.meta.total).toBe(1);
    expect(page.data[0].appointmentId).not.toBe(original);
    expect(page.totals.dueCents).toBe(PRECIO);
  });

  // ── Días del negocio ──────────────────────────────────────────────────────

  /**
   * Mismo criterio que `GET /payments`: los días son días del calendario del
   * negocio. Armando el rango en UTC, un turno de las 23:00 del último día
   * caería en el mes siguiente y el mes no cerraría contra lo que el mostrador
   * vio.
   */
  it('un turno de las 23:00 del último día entra en el mes', async () => {
    const turno = await book(luciaId, centroId);
    // Las 23:00 del último día del mes, en hora de Buenos Aires: en UTC eso ya
    // es el día 1 del mes siguiente, que es exactamente el error que se busca.
    await moveTo(turno, enHorarioDe(ultimoDiaDelMes(LUNES), '23:00'));

    expect((await elMes()).data.map((row) => row.appointmentId)).toEqual([
      turno,
    ]);

    // Una hora después ya es el mes que viene.
    await moveTo(
      turno,
      enHorarioDe(masDias(ultimoDiaDelMes(LUNES), 1), '00:00'),
    );

    expect((await elMes()).data).toEqual([]);
  });

  // ── Filtros y paginación ──────────────────────────────────────────────────

  it('filtra por sucursal y por profesional', async () => {
    const enCentro = await book(luciaId, centroId);
    const enPalermo = await book(anaId, palermoId);

    expect(
      (await elMes(`&branchId=${centroId}`)).data.map(
        (row) => row.appointmentId,
      ),
    ).toEqual([enCentro]);

    expect(
      (await elMes(`&employeeId=${anaId}`)).data.map(
        (row) => row.appointmentId,
      ),
    ).toEqual([enPalermo]);
  });

  /** Paginar no puede mover el número del reporte. */
  it('los totales son del rango entero, no de la página', async () => {
    await book(luciaId, centroId, '10:00');
    await book(luciaId, centroId, '12:00');
    await book(luciaId, centroId, '14:00');

    const page = await elMes('&pageSize=1');

    expect(page.data).toHaveLength(1);
    expect(page.meta).toMatchObject({ total: 3, totalPages: 3 });
    expect(page.totals).toMatchObject({
      appointments: 3,
      dueCents: 3 * PRECIO,
    });
  });

  // ── Validación ────────────────────────────────────────────────────────────

  it('el rango invertido es un 400', async () => {
    await deuda('from=2026-09-30&to=2026-09-01').expect(400);
  });

  it('una fecha que no existe en el calendario es un 400', async () => {
    await deuda('from=2026-02-31&to=2026-03-01').expect(400);
  });

  it('el rango es obligatorio', async () => {
    await deuda('from=2026-09-01').expect(400);
    await deuda('to=2026-09-30').expect(400);
  });

  /** El rango entero pasa por memoria: sin tope, alguien pide diez años. */
  it('un rango de más de 92 días es un 400', async () => {
    await deuda('from=2026-01-01&to=2026-12-31').expect(400);
  });

  // ── Permisos ──────────────────────────────────────────────────────────────

  /** Misma regla que `GET /payments`: la plata del negocio no es de mostrador. */
  it('un PROFESSIONAL no ve lo que falta cobrar', async () => {
    await book(luciaId, centroId);

    await prisma.employee.update({
      where: { id: tenant.employeeId },
      data: { role: 'PROFESSIONAL' },
    });

    await deuda('from=2026-09-01&to=2026-09-30').expect(403);
  });
});
