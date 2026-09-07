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

interface Totals {
  chargedCents: number;
  refundedCents: number;
  netCents: number;
}

interface RangeItem {
  id: string;
  amountCents: number;
  paymentType: string;
  paymentMethod: string;
  status: string;
  paidAt: string;
  recordedBy: { id: string; firstName: string } | null;
  appointment: {
    id: string;
    startsAt: string;
    customerName: string;
    employeeName: string;
    branchName: string;
  };
}

interface RangePage {
  data: RangeItem[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
  totals: Totals;
}

/** `"10:00"` de Buenos Aires como instante ISO (UTC-3 todo el año). */
const enBuenosAires = (hhmm: string): string => enHorarioDe(LUNES, hhmm);

/**
 * El día N del mes del turno, a las 10:00 de Buenos Aires.
 *
 * Anclado al **primero** del mes y no a `LUNES`, que puede caer hasta el 28:
 * sumarle días a un 28 se va de mes en febrero, y este archivo filtra cobros
 * justamente por mes.
 */
const elDia = (n: number): string =>
  enHorarioDe(masDias(primerDiaDelMes(LUNES), n - 1), '10:00');

/** El `from`/`to` que cubre el mes de esa fecha. */
const rangoDe = (fecha: string): string =>
  `from=${primerDiaDelMes(fecha)}&to=${ultimoDiaDelMes(fecha)}`;

describe('Cobros por rango (e2e)', () => {
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

  const range = (query: string) =>
    request(server())
      .get(`/payments?${query}`)
      .set(...auth(tenant.accessToken));

  /** El reporte del mes en el que cae el turno de los tests. */
  async function elMes(extra = ''): Promise<RangePage> {
    const response = await range(`${rangoDe(LUNES)}${extra}`).expect(200);

    return response.body as RangePage;
  }

  beforeEach(async () => {
    await resetDatabase(prisma);
    sandbox.reset();
    tenant = await registerTenant(app);
    await switchPlan(prisma, tenant.tenantId, 'avanzado');
    await setUpBusiness();
  });

  // ── Lo que devuelve ───────────────────────────────────────────────────────

  it('lista los cobros acreditados del rango con sus totales', async () => {
    const turno = await book(luciaId, centroId);
    await pay(turno, 60_000, elDia(8));
    await pay(turno, 40_000, elDia(10));

    const page = await elMes();

    expect(page.meta.total).toBe(2);
    expect(page.totals).toEqual({
      chargedCents: 100_000,
      refundedCents: 0,
      netCents: 100_000,
    });

    // Lo más reciente primero.
    expect(page.data.map((row) => row.amountCents)).toEqual([40_000, 60_000]);

    // Cada fila dice de qué turno era, para poder reconocerla en la grilla.
    expect(page.data[0].appointment).toMatchObject({
      id: turno,
      customerName: 'María López',
      employeeName: 'Lucía Fernández',
      branchName: 'Sucursal Centro',
    });

    // Un cobro cargado a mano deja asentado quién lo hizo.
    expect(page.data[0].recordedBy).toMatchObject({ id: tenant.userId });
  });

  it('una devolución resta del neto y suma a lo devuelto', async () => {
    const turno = await book(luciaId, centroId);
    await pay(turno, 100_000, elDia(8));
    await pay(turno, 30_000, elDia(9), {
      paymentType: 'REFUND',
    });

    const page = await elMes();

    expect(page.meta.total).toBe(2);
    expect(page.totals).toEqual({
      chargedCents: 100_000,
      refundedCents: 30_000,
      netCents: 70_000,
    });
  });

  it('los totales son del rango entero, no de la página', async () => {
    const turno = await book(luciaId, centroId);
    await pay(turno, 60_000, elDia(8));
    await pay(turno, 40_000, elDia(10));

    const page = await elMes('&pageSize=1');

    expect(page.data).toHaveLength(1);
    expect(page.meta).toMatchObject({ total: 2, totalPages: 2, pageSize: 1 });
    expect(page.totals.netCents).toBe(100_000);
  });

  // ── Lo que no devuelve ────────────────────────────────────────────────────

  it('un cobro pendiente no aparece: no tiene fecha de acreditación', async () => {
    const turno = await book(luciaId, centroId);

    // Un checkout deja el pago pendiente hasta que lo confirme el proveedor.
    await request(server())
      .post(`/appointments/${turno}/payments/checkout`)
      .set(...auth(tenant.accessToken))
      .send({})
      .expect(201);

    const page = await elMes();

    expect(page.meta.total).toBe(0);
    expect(page.totals.netCents).toBe(0);
  });

  it('pedir los pendientes es un 400, no una lista vacía', async () => {
    await range(`${rangoDe(LUNES)}&status=PENDING`).expect(400);
    await range(`${rangoDe(LUNES)}&status=FAILED`).expect(400);

    await range(`${rangoDe(LUNES)}&status=SUCCEEDED`).expect(200);
    await range(`${rangoDe(LUNES)}&status=REFUNDED`).expect(200);
  });

  /**
   * El día es el del negocio. Un cobro de las 21:30 de Buenos Aires ya es del
   * día siguiente en UTC: armando el rango sin convertir, caería en octubre y
   * el total de septiembre no cerraría contra lo que el mostrador vio pasar.
   */
  it('los días del rango son los del negocio, no los de UTC', async () => {
    const turno = await book(luciaId, centroId);

    // Las 21:30 del último día del mes en Buenos Aires ya son del día 1 del
    // mes siguiente en UTC, que es el error que se busca.
    await pay(turno, 50_000, enHorarioDe(ultimoDiaDelMes(LUNES), '21:30'));

    const elMesConEse = await elMes();
    expect(elMesConEse.meta.total).toBe(1);
    expect(elMesConEse.totals.netCents).toBe(50_000);

    const mesSiguiente = await range(rangoDe(masMeses(LUNES, 1))).expect(200);
    expect((mesSiguiente.body as RangePage).meta.total).toBe(0);
  });

  it('un cobro de otro mes no entra', async () => {
    const turno = await book(luciaId, centroId);
    await pay(turno, 50_000, enHorarioDe(masMeses(LUNES, -1), '10:00'));

    expect((await elMes()).meta.total).toBe(0);
  });

  it('otro negocio no ve estos cobros', async () => {
    const turno = await book(luciaId, centroId);
    await pay(turno, 50_000, elDia(8));

    const otro = await registerTenant(app, 'Otro Negocio');

    const response = await request(server())
      .get(`/payments?${rangoDe(LUNES)}`)
      .set(...auth(otro.accessToken))
      .expect(200);

    expect((response.body as RangePage).meta.total).toBe(0);
  });

  // ── Filtros ───────────────────────────────────────────────────────────────

  it('filtra por profesional y por sucursal', async () => {
    const deLucia = await book(luciaId, centroId);
    const deAna = await book(anaId, palermoId);

    await pay(deLucia, 60_000, elDia(8));
    await pay(deAna, 40_000, elDia(9));

    expect((await elMes()).totals.netCents).toBe(100_000);

    const lucia = await elMes(`&employeeId=${luciaId}`);
    expect(lucia.meta.total).toBe(1);
    expect(lucia.totals.netCents).toBe(60_000);

    const palermo = await elMes(`&branchId=${palermoId}`);
    expect(palermo.meta.total).toBe(1);
    expect(palermo.totals.netCents).toBe(40_000);

    // Los dos a la vez se cruzan: Lucía no atiende en Palermo.
    const cruce = await elMes(`&employeeId=${luciaId}&branchId=${palermoId}`);
    expect(cruce.meta.total).toBe(0);
  });

  it('filtra por medio de pago', async () => {
    const turno = await book(luciaId, centroId);
    await pay(turno, 60_000, elDia(8), {
      paymentMethod: 'CASH',
    });
    await pay(turno, 40_000, elDia(9), {
      paymentMethod: 'TRANSFER',
    });

    const efectivo = await elMes('&paymentMethod=CASH');
    expect(efectivo.meta.total).toBe(1);
    expect(efectivo.totals.netCents).toBe(60_000);
  });

  // ── Validación ────────────────────────────────────────────────────────────

  it('el rango invertido es un 400', async () => {
    await range('from=2026-09-30&to=2026-09-01').expect(400);
  });

  it('una fecha que no existe en el calendario es un 400', async () => {
    await range('from=2026-02-31&to=2026-03-01').expect(400);
    await range('from=2026-09-01&to=septiembre').expect(400);
  });

  it('el rango es obligatorio', async () => {
    await range('from=2026-09-01').expect(400);
    await range('to=2026-09-30').expect(400);
  });

  // ── Permisos ──────────────────────────────────────────────────────────────

  /**
   * La asimetría con `GET /appointments/:id/payments`, que sigue abierto, es
   * deliberada: cobrar es trabajo de mostrador, leer toda la plata del negocio
   * no.
   */
  it('un PROFESSIONAL no ve la plata del negocio, pero sí la de un turno', async () => {
    const turno = await book(luciaId, centroId);
    await pay(turno, 50_000, elDia(8));

    await prisma.employee.update({
      where: { id: tenant.employeeId },
      data: { role: 'PROFESSIONAL' },
    });

    await range(rangoDe(LUNES)).expect(403);

    await request(server())
      .get(`/appointments/${turno}/payments`)
      .set(...auth(tenant.accessToken))
      .expect(200);
  });
});
