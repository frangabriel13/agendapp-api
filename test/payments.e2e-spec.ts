import { randomUUID } from 'node:crypto';
import { AppointmentStatus, PaymentStatus } from '@prisma/client';
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

/** Lunes, bien adelante en el calendario. */
const LUNES = '2026-09-07';
const DAY_OF_WEEK = 1;

const PRECIO = 100_000;
const SEÑA = 30_000;

interface Balance {
  totalPriceCents: number;
  depositAmountCents: number | null;
  paidCents: number;
  refundedCents: number;
  dueCents: number;
  depositCovered: boolean;
  fullyPaid: boolean;
}

interface PaymentDto {
  id: string;
  amountCents: number;
  currency: string;
  paymentType: string;
  paymentMethod: string;
  status: PaymentStatus;
  notes: string | null;
  checkoutUrl: string | null;
  paidAt: string | null;
  recordedBy: { id: string; firstName: string } | null;
}

interface PaymentsPage {
  balance: Balance;
  payments: PaymentDto[];
}

interface CheckoutResult {
  paymentId: string;
  checkoutUrl: string;
  amountCents: number;
  currency: string;
  paymentType: string;
  reused: boolean;
}

/** `"10:00"` de Buenos Aires como instante ISO (UTC-3 todo el año). */
const enBuenosAires = (hhmm: string): string => {
  const [hours, minutes] = hhmm.split(':').map(Number);

  return `${LUNES}T${String(hours + 3).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:00.000Z`;
};

describe('Pagos (e2e)', () => {
  let app: TestApp;
  let prisma: PrismaService;
  let sandbox: SandboxPaymentProvider;
  let tenant: RegisteredTenant;
  let branchId: string;
  let serviceId: string;
  let employeeId: string;
  let customerId: string;

  beforeAll(async () => {
    ({ app, prisma, payments: sandbox } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();

  // ── Armado del escenario ──────────────────────────────────────────────────

  async function setUpBusiness(): Promise<void> {
    const branch = await request(server())
      .post('/branches')
      .set(...auth(tenant.accessToken))
      .send({ name: 'Sucursal Centro' })
      .expect(201);

    branchId = (branch.body as { id: string }).id;

    await request(server())
      .put(`/branches/${branchId}/business-hours`)
      .set(...auth(tenant.accessToken))
      .send({
        days: Array.from({ length: 7 }, (_, dayOfWeek) => ({
          dayOfWeek,
          opensAt: '09:00',
          closesAt: '18:00',
        })),
      })
      .expect(200);

    const service = await request(server())
      .post('/services')
      .set(...auth(tenant.accessToken))
      .send({
        name: 'Corte y brushing',
        durationMinutes: 60,
        priceCents: PRECIO,
        depositAmountCents: SEÑA,
      })
      .expect(201);

    serviceId = (service.body as { id: string }).id;

    const invitation = await request(server())
      .post('/employees')
      .set(...auth(tenant.accessToken))
      .send({
        email: `${randomUUID()}@e2e.test`,
        firstName: 'Lucía',
        lastName: 'Fernández',
        role: 'PROFESSIONAL',
        branchIds: [branchId],
      })
      .expect(201);

    employeeId = (invitation.body as { employee: { id: string } }).employee.id;

    await request(server())
      .put(`/employees/${employeeId}/schedules`)
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

    await request(server())
      .put(`/services/${serviceId}/employees`)
      .set(...auth(tenant.accessToken))
      .send({ assignments: [{ employeeId, branchId }] })
      .expect(200);

    const customer = await request(server())
      .post('/customers')
      .set(...auth(tenant.accessToken))
      .send({
        firstName: 'María',
        phone: `11 5555-${Math.floor(1000 + Math.random() * 8999)}`,
        email: 'maria@e2e.test',
      })
      .expect(201);

    customerId = (customer.body as { id: string }).id;
  }

  /** Con la bandera prendida, un turno con seña nace esperando el pago. */
  async function requireDeposit(value: boolean): Promise<void> {
    await request(server())
      .patch('/tenants/me/settings')
      .set(...auth(tenant.accessToken))
      .send({ requireDepositForBooking: value })
      .expect(200);
  }

  async function book(startsAt = '10:00'): Promise<string> {
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

  const checkout = (appointmentId: string, body: object = {}) =>
    request(server())
      .post(`/appointments/${appointmentId}/payments/checkout`)
      .set(...auth(tenant.accessToken))
      .send(body);

  const manual = (appointmentId: string, body: object) =>
    request(server())
      .post(`/appointments/${appointmentId}/payments/manual`)
      .set(...auth(tenant.accessToken))
      .send(body);

  async function paymentsOf(appointmentId: string): Promise<PaymentsPage> {
    const response = await request(server())
      .get(`/appointments/${appointmentId}/payments`)
      .set(...auth(tenant.accessToken))
      .expect(200);

    return response.body as PaymentsPage;
  }

  const statusOf = async (id: string): Promise<AppointmentStatus> => {
    const row = await prisma.appointment.findUniqueOrThrow({
      where: { id },
      select: { status: true },
    });

    return row.status;
  };

  /** Le pega al webhook como lo haría el proveedor. */
  const notify = (paymentId: string, type = 'payment') =>
    request(server())
      .post('/webhooks/mercadopago')
      .send({ type, data: { id: paymentId } });

  beforeEach(async () => {
    await resetDatabase(prisma);
    sandbox.reset();
    tenant = await registerTenant(app);
    await switchPlan(prisma, tenant.tenantId, 'pro');
    await setUpBusiness();
  });

  // ── GET /appointments/:id/payments ────────────────────────────────────────

  describe('GET /appointments/:id/payments', () => {
    it('un turno sin pagos debe todo', async () => {
      const appointmentId = await book();

      const { balance, payments } = await paymentsOf(appointmentId);

      expect(payments).toHaveLength(0);
      expect(balance).toEqual({
        totalPriceCents: PRECIO,
        depositAmountCents: SEÑA,
        paidCents: 0,
        refundedCents: 0,
        dueCents: PRECIO,
        depositCovered: false,
        fullyPaid: false,
      });
    });

    it('404 si el turno no existe', async () => {
      await request(server())
        .get(`/appointments/${randomUUID()}/payments`)
        .set(...auth(tenant.accessToken))
        .expect(404);
    });

    it('los pagos de un turno de otro negocio no se ven', async () => {
      const appointmentId = await book();
      const otro = await registerTenant(app, 'Otro Negocio');

      await request(server())
        .get(`/appointments/${appointmentId}/payments`)
        .set(...auth(otro.accessToken))
        .expect(404);
    });
  });

  // ── Checkout ──────────────────────────────────────────────────────────────

  describe('POST /appointments/:id/payments/checkout', () => {
    it('crea el cobro pendiente y devuelve el link', async () => {
      const appointmentId = await book();

      const response = await checkout(appointmentId).expect(201);
      const body = response.body as CheckoutResult;

      expect(body).toMatchObject({
        amountCents: SEÑA,
        currency: 'ARS',
        paymentType: 'DEPOSIT',
        reused: false,
      });
      expect(body.checkoutUrl).toBeTruthy();

      const { payments, balance } = await paymentsOf(appointmentId);

      expect(payments).toHaveLength(1);
      expect(payments[0]).toMatchObject({
        status: PaymentStatus.PENDING,
        paymentMethod: 'MERCADOPAGO',
        amountCents: SEÑA,
      });
      // Pendiente no es pagado: el saldo no se mueve hasta que se acredite.
      expect(balance.paidCents).toBe(0);
    });

    /**
     * Sin esto, cada clic en "pagar" dejaría otra fila pendiente y otro
     * checkout vivo, y el cliente podría pagar dos veces la misma seña.
     */
    it('pedirlo dos veces devuelve el mismo link', async () => {
      const appointmentId = await book();

      const primero = await checkout(appointmentId).expect(201);
      const segundo = await checkout(appointmentId).expect(201);

      const a = primero.body as CheckoutResult;
      const b = segundo.body as CheckoutResult;

      expect(b.reused).toBe(true);
      expect(b.paymentId).toBe(a.paymentId);
      expect(b.checkoutUrl).toBe(a.checkoutUrl);

      const { payments } = await paymentsOf(appointmentId);
      expect(payments).toHaveLength(1);
    });

    it('por defecto cobra la seña, y el saldo cuando ya está cubierta', async () => {
      const appointmentId = await book();

      expect((await checkout(appointmentId).expect(201)).body).toMatchObject({
        paymentType: 'DEPOSIT',
        amountCents: SEÑA,
      });

      await manual(appointmentId, {
        amountCents: SEÑA,
        paymentType: 'DEPOSIT',
        paymentMethod: 'CASH',
      }).expect(201);

      expect((await checkout(appointmentId).expect(201)).body).toMatchObject({
        paymentType: 'REMAINDER',
        amountCents: PRECIO - SEÑA,
      });
    });

    it('se puede pedir el total explícitamente', async () => {
      const appointmentId = await book();

      expect(
        (await checkout(appointmentId, { paymentType: 'FULL' }).expect(201))
          .body,
      ).toMatchObject({ paymentType: 'FULL', amountCents: PRECIO });
    });

    it('no se puede pedir un checkout de devolución', async () => {
      const appointmentId = await book();

      await checkout(appointmentId, { paymentType: 'REFUND' }).expect(400);
    });

    it('un turno cancelado no admite cobros', async () => {
      const appointmentId = await book();

      await request(server())
        .patch(`/appointments/${appointmentId}/status`)
        .set(...auth(tenant.accessToken))
        .send({ status: 'CANCELED_BY_CUSTOMER' })
        .expect(200);

      await checkout(appointmentId).expect(409);
    });

    it('un turno ya pago no tiene nada que cobrar', async () => {
      const appointmentId = await book();

      await manual(appointmentId, {
        amountCents: PRECIO,
        paymentType: 'FULL',
        paymentMethod: 'CASH',
      }).expect(201);

      await checkout(appointmentId).expect(409);
    });

    it('sin seña configurada no se puede cobrar una seña', async () => {
      const sinSeña = await request(server())
        .post('/services')
        .set(...auth(tenant.accessToken))
        .send({ name: 'Peinado', durationMinutes: 30, priceCents: 50_000 })
        .expect(201);

      const otroServicio = (sinSeña.body as { id: string }).id;

      await request(server())
        .put(`/services/${otroServicio}/employees`)
        .set(...auth(tenant.accessToken))
        .send({ assignments: [{ employeeId, branchId }] })
        .expect(200);

      const response = await request(server())
        .post('/appointments')
        .set(...auth(tenant.accessToken))
        .send({
          branchId,
          employeeId,
          customerId,
          serviceIds: [otroServicio],
          startsAt: enBuenosAires('15:00'),
        })
        .expect(201);

      const appointmentId = (response.body as { id: string }).id;

      await checkout(appointmentId, { paymentType: 'DEPOSIT' }).expect(400);
    });
  });

  // ── Webhook ───────────────────────────────────────────────────────────────

  describe('POST /webhooks/mercadopago', () => {
    it('un pago acreditado confirma el turno que esperaba la seña', async () => {
      await requireDeposit(true);
      const appointmentId = await book();

      expect(await statusOf(appointmentId)).toBe(
        AppointmentStatus.PENDING_PAYMENT,
      );

      await checkout(appointmentId).expect(201);
      await notify(sandbox.lastPaymentId()).expect(200);

      expect(await statusOf(appointmentId)).toBe(AppointmentStatus.CONFIRMED);

      const { balance, payments } = await paymentsOf(appointmentId);

      expect(payments[0]).toMatchObject({ status: PaymentStatus.SUCCEEDED });
      expect(payments[0].paidAt).not.toBeNull();
      expect(balance).toMatchObject({
        paidCents: SEÑA,
        dueCents: PRECIO - SEÑA,
        depositCovered: true,
        fullyPaid: false,
      });

      const row = await prisma.appointment.findUniqueOrThrow({
        where: { id: appointmentId },
        select: { depositPaid: true },
      });
      expect(row.depositPaid).toBe(true);
    });

    /**
     * MP entrega los avisos varias veces y desordenados: esto **va a** pasar en
     * producción, no es un caso hipotético.
     */
    it('el mismo aviso dos veces no cobra dos veces', async () => {
      await requireDeposit(true);
      const appointmentId = await book();

      await checkout(appointmentId).expect(201);
      const paymentId = sandbox.lastPaymentId();

      await notify(paymentId).expect(200);
      await notify(paymentId).expect(200);

      const { payments, balance } = await paymentsOf(appointmentId);

      expect(payments).toHaveLength(1);
      expect(balance.paidCents).toBe(SEÑA);
      expect(await statusOf(appointmentId)).toBe(AppointmentStatus.CONFIRMED);
    });

    it('dos avisos simultáneos tampoco', async () => {
      await requireDeposit(true);
      const appointmentId = await book();

      await checkout(appointmentId).expect(201);
      const paymentId = sandbox.lastPaymentId();

      const [a, b] = await Promise.all([notify(paymentId), notify(paymentId)]);

      expect([a.status, b.status]).toEqual([200, 200]);

      const { balance } = await paymentsOf(appointmentId);
      expect(balance.paidCents).toBe(SEÑA);
    });

    it('un pago rechazado deja el turno esperando', async () => {
      await requireDeposit(true);
      const appointmentId = await book();

      await checkout(appointmentId).expect(201);
      const paymentId = sandbox.lastPaymentId();

      sandbox.program(paymentId, {
        status: PaymentStatus.FAILED,
        paidAt: null,
        failureReason: 'cc_rejected_insufficient_amount',
        rawStatus: 'rejected',
      });

      await notify(paymentId).expect(200);

      expect(await statusOf(appointmentId)).toBe(
        AppointmentStatus.PENDING_PAYMENT,
      );

      const { payments, balance } = await paymentsOf(appointmentId);

      expect(payments[0]).toMatchObject({
        status: PaymentStatus.FAILED,
        failureReason: 'cc_rejected_insufficient_amount',
        paidAt: null,
      });
      expect(balance.paidCents).toBe(0);
    });

    /**
     * Una devolución actualiza el saldo pero **no des-confirma** el turno:
     * volver atrás no es una transición válida, y el turno sigue ocupando el
     * lugar en la agenda. Qué hacer con eso lo decide el negocio.
     */
    it('una devolución baja el saldo pero no des-confirma', async () => {
      await requireDeposit(true);
      const appointmentId = await book();

      await checkout(appointmentId).expect(201);
      const paymentId = sandbox.lastPaymentId();

      await notify(paymentId).expect(200);
      expect(await statusOf(appointmentId)).toBe(AppointmentStatus.CONFIRMED);

      sandbox.program(paymentId, {
        status: PaymentStatus.REFUNDED,
        rawStatus: 'refunded',
      });
      await notify(paymentId).expect(200);

      expect(await statusOf(appointmentId)).toBe(AppointmentStatus.CONFIRMED);

      const { balance } = await paymentsOf(appointmentId);
      expect(balance).toMatchObject({
        paidCents: 0,
        refundedCents: SEÑA,
        depositCovered: false,
      });

      const row = await prisma.appointment.findUniqueOrThrow({
        where: { id: appointmentId },
        select: { depositPaid: true },
      });
      expect(row.depositPaid).toBe(false);
    });

    it('una firma que no verifica se rechaza con 401', async () => {
      const appointmentId = await book();
      await checkout(appointmentId).expect(201);

      sandbox.signaturesAre(false);

      await notify(sandbox.lastPaymentId()).expect(401);

      const { payments } = await paymentsOf(appointmentId);
      expect(payments[0].status).toBe(PaymentStatus.PENDING);
    });

    it('un aviso que no es de un pago se ignora con 200', async () => {
      const response = await notify('lo-que-sea', 'merchant_order').expect(200);

      expect(response.body).toEqual({ result: 'ignored' });
    });

    /**
     * El aviso es de un pago real del proveedor, pero de nuestro lado la fila
     * ya no está. Reintentarlo no cambiaría nada, así que se contesta 200 en
     * vez de pedirle a MP que insista.
     */
    it('un aviso de un pago que no está en la base se contesta 200', async () => {
      const appointmentId = await book();
      const created = await checkout(appointmentId).expect(201);

      await prisma.appointmentPayment.delete({
        where: { id: (created.body as CheckoutResult).paymentId },
      });

      const response = await notify(sandbox.lastPaymentId()).expect(200);

      expect(response.body).toEqual({ result: 'unknown_payment' });
    });

    /**
     * Lo contrario del caso anterior: si el proveedor no contesta, hay que
     * dejar que reintente, y para eso la respuesta tiene que ser un error.
     */
    it('si el proveedor no responde, se pide reintento con 502', async () => {
      await notify('un-pago-que-el-proveedor-no-conoce').expect(502);
    });

    /** Una referencia que no es un UUID no puede volarse la consulta. */
    it('una referencia mal formada no rompe nada', async () => {
      const appointmentId = await book();
      await checkout(appointmentId).expect(201);

      sandbox.program(sandbox.lastPaymentId(), { reference: 'no-soy-un-uuid' });

      const response = await notify(sandbox.lastPaymentId()).expect(200);

      expect(response.body).toEqual({ result: 'unknown_payment' });
    });

    it('no necesita token: es público', async () => {
      const appointmentId = await book();
      await checkout(appointmentId).expect(201);

      // Sin header de Authorization en ninguna de las llamadas de arriba.
      await notify(sandbox.lastPaymentId()).expect(200);
      expect(await statusOf(appointmentId)).toBe(AppointmentStatus.CONFIRMED);
    });
  });

  // ── Pagos manuales ────────────────────────────────────────────────────────

  describe('POST /appointments/:id/payments/manual', () => {
    it('el efectivo acredita al instante y confirma el turno', async () => {
      await requireDeposit(true);
      const appointmentId = await book();

      const response = await manual(appointmentId, {
        amountCents: SEÑA,
        paymentType: 'DEPOSIT',
        paymentMethod: 'CASH',
        notes: 'Pagó en el mostrador',
      }).expect(201);

      const payment = response.body as PaymentDto;

      expect(payment).toMatchObject({
        status: PaymentStatus.SUCCEEDED,
        paymentMethod: 'CASH',
        notes: 'Pagó en el mostrador',
      });
      expect(payment.paidAt).not.toBeNull();
      expect(await statusOf(appointmentId)).toBe(AppointmentStatus.CONFIRMED);
    });

    /** Es el único rastro de un movimiento que ningún sistema puede confirmar. */
    it('queda asentado quién lo cargó', async () => {
      const appointmentId = await book();

      const response = await manual(appointmentId, {
        amountCents: SEÑA,
        paymentType: 'DEPOSIT',
        paymentMethod: 'CASH',
      }).expect(201);

      expect((response.body as PaymentDto).recordedBy).toMatchObject({
        id: tenant.userId,
      });
    });

    it('una devolución en el mostrador resta del saldo', async () => {
      const appointmentId = await book();

      await manual(appointmentId, {
        amountCents: PRECIO,
        paymentType: 'FULL',
        paymentMethod: 'CASH',
      }).expect(201);

      await manual(appointmentId, {
        amountCents: 40_000,
        paymentType: 'REFUND',
        paymentMethod: 'CASH',
        notes: 'Devolución por demora',
      }).expect(201);

      const { balance } = await paymentsOf(appointmentId);

      expect(balance).toMatchObject({
        paidCents: PRECIO - 40_000,
        refundedCents: 40_000,
        dueCents: 40_000,
        fullyPaid: false,
      });
    });

    it('no se puede registrar a mano un pago de Mercado Pago', async () => {
      const appointmentId = await book();

      await manual(appointmentId, {
        amountCents: SEÑA,
        paymentType: 'DEPOSIT',
        paymentMethod: 'MERCADOPAGO',
      }).expect(400);
    });

    it('el monto tiene que ser mayor a cero', async () => {
      const appointmentId = await book();

      await manual(appointmentId, {
        amountCents: 0,
        paymentType: 'DEPOSIT',
        paymentMethod: 'CASH',
      }).expect(400);
    });

    it('un turno cancelado no admite pagos', async () => {
      const appointmentId = await book();

      await request(server())
        .patch(`/appointments/${appointmentId}/status`)
        .set(...auth(tenant.accessToken))
        .send({ status: 'CANCELED_BY_BUSINESS' })
        .expect(200);

      await manual(appointmentId, {
        amountCents: SEÑA,
        paymentType: 'DEPOSIT',
        paymentMethod: 'CASH',
      }).expect(409);
    });

    it('un campo de más devuelve 400', async () => {
      const appointmentId = await book();

      await manual(appointmentId, {
        amountCents: SEÑA,
        paymentType: 'DEPOSIT',
        paymentMethod: 'CASH',
        inventado: true,
      }).expect(400);
    });
  });
});
