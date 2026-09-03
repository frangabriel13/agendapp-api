import { randomUUID } from 'node:crypto';
import {
  AppointmentStatus,
  CancellationRefundType,
  PaymentStatus,
} from '@prisma/client';
import request from 'supertest';
import type { SandboxPaymentProvider } from '../src/modules/payments/providers/sandbox-payment.provider';
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

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

/** El seed deja el negocio en Buenos Aires, que es UTC-3 todo el año. */
const BA_OFFSET_HOURS = 3;

const PRECIO = 100_000;
const SEÑA = 30_000;

/** El default del negocio recién creado. */
const POLITICA_POR_DEFECTO_HORAS = 24;

/**
 * El techo que acepta el DTO (30 días). Sirve para dejar cualquier turno
 * **fuera** de la política sin tocar su horario.
 */
const POLITICA_MAXIMA_HORAS = 720;

/**
 * Las fechas van contra el reloj, no fijas.
 *
 * Acá no es una preferencia: lo que se prueba es con cuánta anticipación se
 * canceló, que es una distancia entre dos instantes. Un turno escrito a mano
 * ("el lunes 7") hoy está a diez días y en tres semanas está en el pasado: los
 * tests de "canceló en término" pasarían hasta esa fecha y empezarían a fallar
 * solos, sin que nadie haya tocado nada.
 */
function businessDate(daysAhead: number): string {
  const instant = new Date(
    Date.now() - BA_OFFSET_HOURS * 60 * 60 * 1_000 + daysAhead * MS_PER_DAY,
  );

  return instant.toISOString().slice(0, 10);
}

/** `"10:00"` de ese día en Buenos Aires, como instante ISO. */
function at(dateOnly: string, hhmm: string): string {
  const [hours, minutes] = hhmm.split(':').map(Number);

  return `${dateOnly}T${String(hours + BA_OFFSET_HOURS).padStart(2, '0')}:${String(
    minutes,
  ).padStart(2, '0')}:00.000Z`;
}

interface RefundDto {
  type: CancellationRefundType;
  amountCents: number;
  withinPolicy: boolean;
  reason: string;
}

interface ChangeStatusResult {
  appointment: {
    id: string;
    status: AppointmentStatus;
    canceledAt: string | null;
    cancellationReason: string | null;
  };
  refund: RefundDto | null;
}

interface Balance {
  totalPriceCents: number;
  depositAmountCents: number | null;
  paidCents: number;
  refundedCents: number;
  dueCents: number;
  depositCovered: boolean;
  fullyPaid: boolean;
}

describe('Cancelación y devolución (e2e)', () => {
  let app: TestApp;
  let prisma: PrismaService;
  let sandbox: SandboxPaymentProvider;
  let tenant: RegisteredTenant;
  let branchId: string;
  let serviceId: string;
  let employeeId: string;
  let customerId: string;

  /** Bien adelante: así "canceló en término" da en término con el default. */
  const DIA = businessDate(10);

  beforeAll(async () => {
    ({ app, prisma, payments: sandbox } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();
  const asOwner = () => auth(tenant.accessToken);

  // ── Armado del escenario ──────────────────────────────────────────────────

  async function createBranch(): Promise<string> {
    const response = await request(server())
      .post('/branches')
      .set(...asOwner())
      .send({ name: 'Sucursal Centro' })
      .expect(201);

    const id = (response.body as { id: string }).id;

    // Abierta todos los días: qué día de la semana cae `DIA` depende de cuándo
    // se corra la suite, y no es lo que se está probando.
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
        priceCents: PRECIO,
        depositAmountCents: SEÑA,
        ...body,
      })
      .expect(201);

    const id = (response.body as { id: string }).id;

    await request(server())
      .put(`/services/${id}/employees`)
      .set(...asOwner())
      .send({ assignments: [{ employeeId, branchId }] })
      .expect(200);

    return id;
  }

  async function createProfessional(): Promise<string> {
    const invitation = await request(server())
      .post('/employees')
      .set(...asOwner())
      .send({
        email: `${randomUUID()}@e2e.test`,
        firstName: 'Lucía',
        lastName: 'Fernández',
        role: 'PROFESSIONAL',
        branchIds: [branchId],
      })
      .expect(201);

    const id = (invitation.body as { employee: { id: string } }).employee.id;

    await request(server())
      .put(`/employees/${id}/schedules`)
      .set(...asOwner())
      .send({
        shifts: Array.from({ length: 7 }, (_, dayOfWeek) => ({
          branchId,
          dayOfWeek,
          startsAt: '09:00',
          endsAt: '18:00',
        })),
      })
      .expect(200);

    return id;
  }

  async function createCustomer(): Promise<string> {
    const response = await request(server())
      .post('/customers')
      .set(...asOwner())
      .send({
        firstName: 'María',
        phone: `11 5555-${Math.floor(1000 + Math.random() * 8999)}`,
        email: 'maria@e2e.test',
      })
      .expect(201);

    return (response.body as { id: string }).id;
  }

  /** Cambia la política de cancelación del negocio, por la API real. */
  async function politica(body: Record<string, unknown>): Promise<void> {
    await request(server())
      .patch('/tenants/me/settings')
      .set(...asOwner())
      .send(body)
      .expect(200);
  }

  async function book(service = serviceId, hhmm = '10:00'): Promise<string> {
    const response = await request(server())
      .post('/appointments')
      .set(...asOwner())
      .send({
        branchId,
        employeeId,
        customerId,
        serviceIds: [service],
        startsAt: at(DIA, hhmm),
      })
      .expect(201);

    return (response.body as { id: string }).id;
  }

  /**
   * La seña, cobrada de verdad: link de pago y aviso del proveedor.
   *
   * Es la diferencia con los tests de cancelación que ya viven en
   * `appointments.e2e-spec.ts`, que escriben `depositPaid` a mano en la base.
   * Acá la plata entra por donde entra en producción, así que si el webhook
   * dejara de marcar la seña, estos tests lo verían.
   */
  async function cobrarSeña(appointmentId: string): Promise<string> {
    await request(server())
      .post(`/appointments/${appointmentId}/payments/checkout`)
      .set(...asOwner())
      .send({})
      .expect(201);

    const paymentId = sandbox.lastPaymentId();

    await request(server())
      .post('/webhooks/mercadopago')
      .send({ type: 'payment', data: { id: paymentId } })
      .expect(200);

    return paymentId;
  }

  const cancelar = (
    id: string,
    body: Record<string, unknown> = {},
  ): request.Test =>
    request(server())
      .patch(`/appointments/${id}/status`)
      .set(...asOwner())
      .send({ status: AppointmentStatus.CANCELED_BY_CUSTOMER, ...body });

  async function saldo(appointmentId: string): Promise<Balance> {
    const response = await request(server())
      .get(`/appointments/${appointmentId}/payments`)
      .set(...asOwner())
      .expect(200);

    return (response.body as { balance: Balance }).balance;
  }

  /** Cancela y devuelve solo la decisión de devolución. */
  async function cancelarYVerDevolucion(id: string): Promise<RefundDto> {
    const response = await cancelar(id).expect(200);
    const { refund } = response.body as ChangeStatusResult;

    if (refund === null) {
      throw new Error('Cancelar tiene que traer una decisión de devolución');
    }

    return refund;
  }

  beforeEach(async () => {
    await resetDatabase(prisma);
    sandbox.reset();
    tenant = await registerTenant(app);
    await switchPlan(prisma, tenant.tenantId, 'pro');
    branchId = await createBranch();
    employeeId = await createProfessional();
    serviceId = await createService();
    customerId = await createCustomer();
  });

  // ── Canceló en término ────────────────────────────────────────────────────

  describe('Con la seña cobrada y cancelando en término', () => {
    it('con reembolso total corresponde devolver la seña entera', async () => {
      const turno = await book();
      await cobrarSeña(turno);

      expect(await cancelarYVerDevolucion(turno)).toMatchObject({
        type: CancellationRefundType.FULL,
        amountCents: SEÑA,
        withinPolicy: true,
      });
    });

    it('con reembolso parcial corresponde el porcentaje configurado', async () => {
      await politica({
        cancellationRefundType: CancellationRefundType.PARTIAL,
        cancellationRefundPercentage: 40,
      });

      const turno = await book();
      await cobrarSeña(turno);

      expect(await cancelarYVerDevolucion(turno)).toMatchObject({
        type: CancellationRefundType.PARTIAL,
        amountCents: SEÑA * 0.4,
        withinPolicy: true,
      });
    });

    /**
     * Un porcentaje que no divide justo. Si el cálculo truncara en vez de
     * redondear, acá saldría 6172 y el negocio se quedaría con un centavo por
     * cancelación — el clásico error de plata que nadie mira hasta que alguien
     * suma un año.
     */
    it('el parcial redondea al centavo, no trunca', async () => {
      await politica({
        cancellationRefundType: CancellationRefundType.PARTIAL,
        cancellationRefundPercentage: 50,
      });

      const impar = await createService({ depositAmountCents: 12_345 });
      const turno = await book(impar);
      await cobrarSeña(turno);

      expect(await cancelarYVerDevolucion(turno)).toMatchObject({
        type: CancellationRefundType.PARTIAL,
        amountCents: 6_173,
      });
    });

    it('con crédito no vuelve plata, pero queda a favor por el mismo monto', async () => {
      await politica({
        cancellationRefundType: CancellationRefundType.CREDIT,
      });

      const turno = await book();
      await cobrarSeña(turno);

      expect(await cancelarYVerDevolucion(turno)).toMatchObject({
        type: CancellationRefundType.CREDIT,
        amountCents: SEÑA,
        withinPolicy: true,
      });
    });

    it('si el negocio no devuelve señas, no devuelve ni en término', async () => {
      await politica({ cancellationRefundType: CancellationRefundType.NONE });

      const turno = await book();
      await cobrarSeña(turno);

      expect(await cancelarYVerDevolucion(turno)).toMatchObject({
        type: CancellationRefundType.NONE,
        amountCents: 0,
        withinPolicy: true,
      });
    });
  });

  // ── Canceló tarde ─────────────────────────────────────────────────────────

  describe('Con la seña cobrada y cancelando tarde', () => {
    /**
     * Se estira la política en vez de acercar el turno.
     *
     * Mover el turno para atrás obligaría a escribir en la base por afuera de
     * la API (desde la API, cambiar el horario es reprogramar, que es otra
     * cosa). Estirando la ventana a 30 días, un turno a diez queda tarde por la
     * misma cuenta y todo pasa por endpoints reales.
     */
    async function ventanaImposible(): Promise<void> {
      await politica({ cancellationPolicyHours: POLITICA_MAXIMA_HORAS });
    }

    it('no corresponde devolución aunque la política sea total', async () => {
      await ventanaImposible();

      const turno = await book();
      await cobrarSeña(turno);

      expect(await cancelarYVerDevolucion(turno)).toMatchObject({
        type: CancellationRefundType.NONE,
        amountCents: 0,
        withinPolicy: false,
      });
    });

    it('el motivo dice cuántas horas de anticipación pedía el negocio', async () => {
      await ventanaImposible();

      const turno = await book();
      await cobrarSeña(turno);

      const refund = await cancelarYVerDevolucion(turno);

      expect(refund.reason).toContain(String(POLITICA_MAXIMA_HORAS));
    });

    it('tarde tampoco devuelve con reembolso parcial', async () => {
      await ventanaImposible();
      await politica({
        cancellationRefundType: CancellationRefundType.PARTIAL,
        cancellationRefundPercentage: 50,
      });

      const turno = await book();
      await cobrarSeña(turno);

      expect(await cancelarYVerDevolucion(turno)).toMatchObject({
        type: CancellationRefundType.NONE,
        amountCents: 0,
        withinPolicy: false,
      });
    });

    /**
     * La ventana se mide contra el arranque del turno, no contra el día.
     * Con la política en cero, cancelar un minuto antes sigue siendo "en
     * término": es el negocio que no pone ninguna condición.
     */
    it('con la política en cero, nunca se cancela tarde', async () => {
      await politica({ cancellationPolicyHours: 0 });

      const turno = await book();
      await cobrarSeña(turno);

      expect(await cancelarYVerDevolucion(turno)).toMatchObject({
        type: CancellationRefundType.FULL,
        amountCents: SEÑA,
        withinPolicy: true,
      });
    });
  });

  // ── Plata que no está ─────────────────────────────────────────────────────

  describe('Sin plata cobrada no hay nada que devolver', () => {
    it('un turno sin seña configurada', async () => {
      const sinSeña = await createService({ depositAmountCents: null });
      const turno = await book(sinSeña);

      expect(await cancelarYVerDevolucion(turno)).toMatchObject({
        type: CancellationRefundType.NONE,
        amountCents: 0,
        withinPolicy: true,
      });
    });

    /**
     * El caso que separa "pidió el link" de "pagó": el checkout deja un cobro
     * pendiente, y hasta que no llegue el aviso del proveedor no entró un peso.
     * Si la devolución mirara la seña configurada en vez de la cobrada, acá
     * saldría a devolver treinta mil pesos que nunca entraron.
     */
    it('un checkout pedido pero nunca acreditado', async () => {
      const turno = await book();

      await request(server())
        .post(`/appointments/${turno}/payments/checkout`)
        .set(...asOwner())
        .send({})
        .expect(201);

      expect((await saldo(turno)).paidCents).toBe(0);

      expect(await cancelarYVerDevolucion(turno)).toMatchObject({
        type: CancellationRefundType.NONE,
        amountCents: 0,
      });
    });

    /**
     * Contracargo: el proveedor ya revirtió la seña por su cuenta. La plata
     * volvió sola, así que devolverla otra vez sería pagar dos veces la misma
     * cancelación.
     */
    it('una seña que el proveedor ya revirtió', async () => {
      const turno = await book();
      const paymentId = await cobrarSeña(turno);

      sandbox.program(paymentId, { status: PaymentStatus.REFUNDED });
      await request(server())
        .post('/webhooks/mercadopago')
        .send({ type: 'payment', data: { id: paymentId } })
        .expect(200);

      expect(await cancelarYVerDevolucion(turno)).toMatchObject({
        type: CancellationRefundType.NONE,
        amountCents: 0,
      });
    });
  });

  // ── El recorrido completo del mostrador ───────────────────────────────────

  describe('De la decisión a la plata devuelta', () => {
    /**
     * El circuito entero, que es lo que nadie probaba: se cobra la seña, se
     * cancela, y **la devolución se registra por el monto que dijo `refund`**.
     * Si ese número no cerrara con lo que el saldo considera cobrado, el
     * mostrador devolvería de más o de menos y el turno quedaría con saldo
     * fantasma.
     */
    it('devolver exactamente lo que dijo la cancelación deja el saldo en cero', async () => {
      const turno = await book();
      await cobrarSeña(turno);

      expect(await saldo(turno)).toMatchObject({
        paidCents: SEÑA,
        refundedCents: 0,
      });

      const refund = await cancelarYVerDevolucion(turno);

      await request(server())
        .post(`/appointments/${turno}/payments/manual`)
        .set(...asOwner())
        .send({
          amountCents: refund.amountCents,
          paymentType: 'REFUND',
          paymentMethod: 'CASH',
          notes: refund.reason,
        })
        .expect(201);

      expect(await saldo(turno)).toMatchObject({
        paidCents: 0,
        refundedCents: SEÑA,
      });
    });

    it('con reembolso parcial queda en caja lo que el negocio se quedó', async () => {
      await politica({
        cancellationRefundType: CancellationRefundType.PARTIAL,
        cancellationRefundPercentage: 30,
      });

      const turno = await book();
      await cobrarSeña(turno);

      const refund = await cancelarYVerDevolucion(turno);

      await request(server())
        .post(`/appointments/${turno}/payments/manual`)
        .set(...asOwner())
        .send({
          amountCents: refund.amountCents,
          paymentType: 'REFUND',
          paymentMethod: 'TRANSFER',
        })
        .expect(201);

      expect(await saldo(turno)).toMatchObject({
        paidCents: SEÑA * 0.7,
        refundedCents: SEÑA * 0.3,
      });
    });

    /**
     * Una devolución de cero no se puede registrar: el monto mínimo es uno.
     * Es lo correcto —una fila de cero pesos no dice nada— pero significa que
     * el mostrador tiene que mirar `amountCents` antes de intentar el POST.
     */
    it('cuando no corresponde devolver, no hay nada que registrar', async () => {
      await politica({ cancellationRefundType: CancellationRefundType.NONE });

      const turno = await book();
      await cobrarSeña(turno);

      const refund = await cancelarYVerDevolucion(turno);
      expect(refund.amountCents).toBe(0);

      await request(server())
        .post(`/appointments/${turno}/payments/manual`)
        .set(...asOwner())
        .send({
          amountCents: refund.amountCents,
          paymentType: 'REFUND',
          paymentMethod: 'CASH',
        })
        .expect(400);
    });

    /**
     * Los dos lados de la regla, en un test solo.
     *
     * Un turno cancelado no admite que le **entre** plata, pero sí que le
     * salga: si no, el circuito de arriba sería imposible de cerrar. La
     * primera versión de `assertChargeable` bloqueaba las dos cosas y los dos
     * tests de este bloque fallaban con 409 — el arreglo está en
     * `PaymentsService.recordManual`.
     */
    it('un turno cancelado admite la devolución, pero no un cobro nuevo', async () => {
      const turno = await book();
      await cobrarSeña(turno);
      await cancelar(turno).expect(200);

      const movimiento = (paymentType: string, amountCents: number) =>
        request(server())
          .post(`/appointments/${turno}/payments/manual`)
          .set(...asOwner())
          .send({ amountCents, paymentType, paymentMethod: 'CASH' });

      await movimiento('REFUND', SEÑA).expect(201);
      await movimiento('REMAINDER', 1_000).expect(409);
    });
  });

  // ── Lo que la cancelación deja escrito ────────────────────────────────────

  describe('Alrededor de la devolución', () => {
    it('cerrar el turno como atendido no calcula ninguna devolución', async () => {
      const turno = await book();
      await cobrarSeña(turno);

      const response = await request(server())
        .patch(`/appointments/${turno}/status`)
        .set(...asOwner())
        .send({ status: AppointmentStatus.ATTENDED })
        .expect(200);

      expect((response.body as ChangeStatusResult).refund).toBeNull();
    });

    it('un turno ya cancelado no se puede volver a cancelar', async () => {
      const turno = await book();
      await cobrarSeña(turno);

      await cancelar(turno).expect(200);
      await cancelar(turno).expect(409);
    });

    it('la devolución viaja junto al turno ya cancelado, no antes', async () => {
      const turno = await book();
      await cobrarSeña(turno);

      const response = await cancelar(turno, {
        cancellationReason: 'Se le complicó',
      }).expect(200);

      const { appointment, refund } = response.body as ChangeStatusResult;

      expect(appointment.status).toBe(AppointmentStatus.CANCELED_BY_CUSTOMER);
      expect(appointment.canceledAt).not.toBeNull();
      expect(appointment.cancellationReason).toBe('Se le complicó');
      expect(refund).toMatchObject({ amountCents: SEÑA });
    });

    /**
     * ⚠️ **Esto documenta el comportamiento de hoy, no lo bendice.** La ventana
     * de anticipación se aplica igual cancele quien cancele: si el negocio
     * cancela sobre la hora, la clienta pierde la seña por una decisión que no
     * fue suya. Es una regla de negocio a revisar, y está acá para que el día
     * que se cambie el test lo diga en voz alta en vez de romperse en silencio.
     */
    it('cancelar el negocio tarde le hace perder la seña a la clienta', async () => {
      await politica({ cancellationPolicyHours: POLITICA_MAXIMA_HORAS });

      const turno = await book();
      await cobrarSeña(turno);

      const response = await cancelar(turno, {
        status: AppointmentStatus.CANCELED_BY_BUSINESS,
        cancellationReason: 'Se cortó la luz',
      }).expect(200);

      expect((response.body as ChangeStatusResult).refund).toMatchObject({
        type: CancellationRefundType.NONE,
        amountCents: 0,
        withinPolicy: false,
      });
    });

    /**
     * ⚠️ **Otro comportamiento documentado, no aprobado.** La devolución se
     * calcula siempre **sobre la seña**, aun cuando se pagó el turno entero por
     * adelantado: quien pagó cien mil y cancela en término recibe treinta mil.
     * El resto sigue en la caja del negocio y hay que devolverlo a mano.
     */
    it('pagar todo por adelantado no agranda la devolución: sale de la seña', async () => {
      const turno = await book();

      await request(server())
        .post(`/appointments/${turno}/payments/manual`)
        .set(...asOwner())
        .send({
          amountCents: PRECIO,
          paymentType: 'FULL',
          paymentMethod: 'CASH',
        })
        .expect(201);

      expect(await saldo(turno)).toMatchObject({
        paidCents: PRECIO,
        fullyPaid: true,
      });

      expect(await cancelarYVerDevolucion(turno)).toMatchObject({
        type: CancellationRefundType.FULL,
        amountCents: SEÑA,
      });
    });

    it('la política default son 24 horas', async () => {
      const response = await request(server())
        .get('/tenants/me/settings')
        .set(...asOwner())
        .expect(200);

      expect(response.body).toMatchObject({
        cancellationPolicyHours: POLITICA_POR_DEFECTO_HORAS,
        cancellationRefundType: CancellationRefundType.FULL,
      });
    });
  });
});
