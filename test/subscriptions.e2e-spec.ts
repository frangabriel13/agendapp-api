import { randomUUID } from 'node:crypto';
import { PaymentStatus, SubscriptionStatus } from '@prisma/client';
import request from 'supertest';
import type { SandboxPaymentProvider } from '../src/modules/payments/providers/sandbox-payment.provider';
import { SubscriptionsService } from '../src/modules/subscriptions/subscriptions.service';
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

const DIA = 24 * 60 * 60 * 1000;

/** El default de `SUBSCRIPTION_GRACE_DAYS`. */
const GRACE_DAYS = 7;

interface SubscriptionResponse {
  status: SubscriptionStatus;
  plan: { slug: string; priceMonthlyCents: number | null };
  currentPeriodStart: string;
  currentPeriodEnd: string;
  daysOverdue: number;
  blocked: boolean;
  graceDays: number;
  payments: {
    id: string;
    amountCents: number;
    status: PaymentStatus;
    periodStart: string;
    periodEnd: string;
  }[];
}

interface CheckoutResult {
  paymentId: string;
  checkoutUrl: string;
  amountCents: number;
  periodStart: string;
  periodEnd: string;
  reused: boolean;
}

describe('Suscripciones (e2e)', () => {
  let app: TestApp;
  let prisma: PrismaService;
  let sandbox: SandboxPaymentProvider;
  let subscriptions: SubscriptionsService;
  let tenant: RegisteredTenant;

  beforeAll(async () => {
    ({ app, prisma, payments: sandbox } = await createTestApp());
    subscriptions = app.get(SubscriptionsService);
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();

  beforeEach(async () => {
    await resetDatabase(prisma);
    sandbox.reset();
    tenant = await registerTenant(app);
  });

  /**
   * Mueve el período entero al pasado para simular el paso del tiempo.
   *
   * **Los dos extremos, no solo el fin**: hay un CHECK de la Fase 1
   * (`subscriptions_period_valid`) que exige `end > start`, y correr solo el
   * fin deja el período invertido.
   */
  async function periodEndedDaysAgo(days: number): Promise<void> {
    const end = new Date(Date.now() - days * DIA);

    await prisma.subscription.updateMany({
      where: { tenantId: tenant.tenantId },
      data: {
        currentPeriodStart: new Date(end.getTime() - 30 * DIA),
        currentPeriodEnd: end,
      },
    });
  }

  const getSubscription = async (): Promise<SubscriptionResponse> => {
    const response = await request(server())
      .get('/tenants/me/subscription')
      .set(...auth(tenant.accessToken))
      .expect(200);

    return response.body as SubscriptionResponse;
  };

  const checkout = () =>
    request(server())
      .post('/tenants/me/subscription/checkout')
      .set(...auth(tenant.accessToken));

  const notify = (paymentId: string) =>
    request(server())
      .post('/webhooks/mercadopago')
      .send({ type: 'payment', data: { id: paymentId } });

  const statusInDb = async (): Promise<{
    subscription: SubscriptionStatus;
    tenant: SubscriptionStatus;
  }> => {
    const [subscription, row] = await Promise.all([
      prisma.subscription.findFirstOrThrow({
        where: { tenantId: tenant.tenantId },
        select: { status: true },
      }),
      prisma.tenant.findUniqueOrThrow({
        where: { id: tenant.tenantId },
        select: { subscriptionStatus: true },
      }),
    ]);

    return {
      subscription: subscription.status,
      tenant: row.subscriptionStatus,
    };
  };

  // ── Estado ────────────────────────────────────────────────────────────────

  describe('GET /tenants/me/subscription', () => {
    it('un negocio recién registrado está en prueba y al día', async () => {
      const body = await getSubscription();

      expect(body).toMatchObject({
        status: SubscriptionStatus.TRIAL,
        daysOverdue: 0,
        blocked: false,
        graceDays: GRACE_DAYS,
        payments: [],
      });
      expect(body.plan.slug).toBe('basico');
    });

    it('informa cuántos días hace que debe', async () => {
      await periodEndedDaysAgo(3);

      expect((await getSubscription()).daysOverdue).toBe(3);
    });

    /** No es trabajo de mostrador: es la cuenta del negocio. */
    it('un profesional no puede ver la suscripción', async () => {
      await switchPlan(prisma, tenant.tenantId, 'pro');

      const invitation = await request(server())
        .post('/employees')
        .set(...auth(tenant.accessToken))
        .send({
          email: `${randomUUID()}@e2e.test`,
          firstName: 'Lucía',
          lastName: 'Fernández',
          role: 'PROFESSIONAL',
        })
        .expect(201);

      const url = (invitation.body as { activationUrl: string }).activationUrl;

      await request(server())
        .post('/employees/activate')
        .send({
          token: new URL(url).searchParams.get('token'),
          password: 'claveNueva123',
        })
        .expect(204);

      const login = await request(server())
        .post('/auth/login')
        .send({
          email: (invitation.body as { employee: { user: { email: string } } })
            .employee.user.email,
          password: 'claveNueva123',
        })
        .expect(200);

      await request(server())
        .get('/tenants/me/subscription')
        .set(...auth((login.body as { accessToken: string }).accessToken))
        .expect(403);
    });
  });

  // ── Cobro del mes ─────────────────────────────────────────────────────────

  describe('POST /tenants/me/subscription/checkout', () => {
    it('genera el link y deja el cobro pendiente', async () => {
      const response = await checkout().expect(201);
      const body = response.body as CheckoutResult;

      expect(body.reused).toBe(false);
      expect(body.checkoutUrl).toBeTruthy();
      // El plan básico son $25.000.
      expect(body.amountCents).toBe(2_500_000);

      const { payments, status } = await getSubscription();

      expect(payments).toHaveLength(1);
      expect(payments[0]).toMatchObject({ status: PaymentStatus.PENDING });
      // Pendiente no reactiva nada: sigue en prueba hasta que se acredite.
      expect(status).toBe(SubscriptionStatus.TRIAL);
    });

    it('pedirlo dos veces no genera dos cobros del mismo mes', async () => {
      const primero = (await checkout().expect(201)).body as CheckoutResult;
      const segundo = (await checkout().expect(201)).body as CheckoutResult;

      expect(segundo.reused).toBe(true);
      expect(segundo.paymentId).toBe(primero.paymentId);
      expect((await getSubscription()).payments).toHaveLength(1);
    });

    /** El plan Empresa se cotiza con soporte: no tiene precio de lista. */
    it('un plan sin precio no se puede pagar desde el panel', async () => {
      await switchPlan(prisma, tenant.tenantId, 'empresa');
      await prisma.subscription.updateMany({
        where: { tenantId: tenant.tenantId },
        data: {
          planId: (
            await prisma.plan.findUniqueOrThrow({ where: { slug: 'empresa' } })
          ).id,
        },
      });

      await checkout().expect(409);
    });
  });

  // ── Acreditación ──────────────────────────────────────────────────────────

  describe('Cuando el pago se acredita', () => {
    it('la suscripción queda activa y el período avanza', async () => {
      const antes = await getSubscription();

      const created = (await checkout().expect(201)).body as CheckoutResult;
      await notify(sandbox.lastPaymentId()).expect(200);

      const despues = await getSubscription();

      expect(despues.status).toBe(SubscriptionStatus.ACTIVE);
      expect(despues.currentPeriodEnd).toBe(created.periodEnd);
      expect(new Date(despues.currentPeriodEnd).getTime()).toBeGreaterThan(
        new Date(antes.currentPeriodEnd).getTime(),
      );
      expect(despues.payments[0].status).toBe(PaymentStatus.SUCCEEDED);
    });

    /**
     * El espejo: `Tenant.subscriptionStatus` es lo que lee `/auth/me` en cada
     * request. Si se desincroniza, la app muestra un estado y bloquea por otro.
     */
    it('el estado del tenant queda sincronizado', async () => {
      await checkout().expect(201);
      await notify(sandbox.lastPaymentId()).expect(200);

      expect(await statusInDb()).toEqual({
        subscription: SubscriptionStatus.ACTIVE,
        tenant: SubscriptionStatus.ACTIVE,
      });

      const me = await request(server())
        .get('/auth/me')
        .set(...auth(tenant.accessToken))
        .expect(200);

      expect(
        (me.body as { tenant: { subscriptionStatus: string } }).tenant
          .subscriptionStatus,
      ).toBe(SubscriptionStatus.ACTIVE);
    });

    /**
     * El aviso repetido **no puede correr el vencimiento un mes más cada vez**.
     * Por eso la renovación guarda el `periodEnd` de la fila del pago y no uno
     * recalculado.
     */
    it('el mismo aviso dos veces no regala un mes', async () => {
      await checkout().expect(201);
      const paymentId = sandbox.lastPaymentId();

      await notify(paymentId).expect(200);
      const primera = await getSubscription();

      await notify(paymentId).expect(200);
      const segunda = await getSubscription();

      expect(segunda.currentPeriodEnd).toBe(primera.currentPeriodEnd);
      expect(segunda.payments).toHaveLength(1);
    });

    it('un pago rechazado no reactiva nada', async () => {
      await checkout().expect(201);
      const paymentId = sandbox.lastPaymentId();

      sandbox.program(paymentId, {
        status: PaymentStatus.FAILED,
        paidAt: null,
        failureReason: 'cc_rejected_insufficient_amount',
        rawStatus: 'rejected',
      });

      await notify(paymentId).expect(200);

      const body = await getSubscription();
      expect(body.status).toBe(SubscriptionStatus.TRIAL);
      expect(body.payments[0].status).toBe(PaymentStatus.FAILED);
    });

    /** El mismo webhook atiende los dos tipos de cobro. */
    it('el aviso llega por el mismo endpoint que los pagos de turnos', async () => {
      await checkout().expect(201);

      const response = await notify(sandbox.lastPaymentId()).expect(200);

      expect(response.body).toEqual({ result: 'applied' });
    });
  });

  // ── Vencimiento ───────────────────────────────────────────────────────────

  describe('Vencimiento (el cron)', () => {
    it('una prueba que se terminó pasa a vencida', async () => {
      await periodEndedDaysAgo(1);

      expect(await subscriptions.expireLapsed()).toBe(1);

      expect(await statusInDb()).toEqual({
        subscription: SubscriptionStatus.PAST_DUE,
        tenant: SubscriptionStatus.PAST_DUE,
      });
    });

    it('no toca las que están al día', async () => {
      expect(await subscriptions.expireLapsed()).toBe(0);
      expect((await statusInDb()).subscription).toBe(SubscriptionStatus.TRIAL);
    });

    /** Corre en cada instancia de la app: la segunda vez no tiene qué hacer. */
    it('correrlo dos veces es inofensivo', async () => {
      await periodEndedDaysAgo(1);

      expect(await subscriptions.expireLapsed()).toBe(1);
      expect(await subscriptions.expireLapsed()).toBe(0);
    });
  });

  // ── El corte de servicio ──────────────────────────────────────────────────

  describe('Bloqueo por falta de pago', () => {
    /** Deja el negocio vencido hace N días, con el catálogo listo para agendar. */
    async function overdueBy(days: number): Promise<{
      branchId: string;
      serviceId: string;
      employeeId: string;
      customerId: string;
    }> {
      await switchPlan(prisma, tenant.tenantId, 'pro');

      const branch = await request(server())
        .post('/branches')
        .set(...auth(tenant.accessToken))
        .send({ name: 'Centro' })
        .expect(201);

      const branchId = (branch.body as { id: string }).id;

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
        .send({ name: 'Corte', durationMinutes: 60, priceCents: 100_000 })
        .expect(201);

      const serviceId = (service.body as { id: string }).id;

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

      const employeeId = (invitation.body as { employee: { id: string } })
        .employee.id;

      await request(server())
        .put(`/employees/${employeeId}/schedules`)
        .set(...auth(tenant.accessToken))
        .send({
          shifts: Array.from({ length: 7 }, (_, dayOfWeek) => ({
            branchId,
            dayOfWeek,
            startsAt: '09:00',
            endsAt: '18:00',
          })),
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
        .send({ firstName: 'María', phone: '11 5555-4444' })
        .expect(201);

      // Recién ahora se vence: armar el catálogo con la cuenta bloqueada sería
      // pelear contra el gate en el setup.
      await periodEndedDaysAgo(days);
      await subscriptions.expireLapsed();

      return {
        branchId,
        serviceId,
        employeeId,
        customerId: (customer.body as { id: string }).id,
      };
    }

    const book = (
      ctx: {
        branchId: string;
        serviceId: string;
        employeeId: string;
        customerId: string;
      },
      startsAt: string,
    ) =>
      request(server())
        .post('/appointments')
        .set(...auth(tenant.accessToken))
        .send({
          branchId: ctx.branchId,
          employeeId: ctx.employeeId,
          customerId: ctx.customerId,
          serviceIds: [ctx.serviceId],
          startsAt,
        });

    /** Una tarjeta que rebota se arregla en un día: no se corta por eso. */
    it('deber poco no bloquea', async () => {
      const ctx = await overdueBy(2);

      await book(ctx, '2026-09-07T13:00:00.000Z').expect(201);
    });

    it('pasada la gracia devuelve 402', async () => {
      const ctx = await overdueBy(GRACE_DAYS + 1);

      const response = await book(ctx, '2026-09-07T13:00:00.000Z').expect(402);

      expect((response.body as { message: string }).message).toMatch(
        /suscripción está vencida/i,
      );
    });

    it('las series repetidas también', async () => {
      const ctx = await overdueBy(GRACE_DAYS + 1);

      await request(server())
        .post('/appointments/recurring')
        .set(...auth(tenant.accessToken))
        .send({
          branchId: ctx.branchId,
          employeeId: ctx.employeeId,
          customerId: ctx.customerId,
          serviceIds: [ctx.serviceId],
          startsAt: '2026-09-07T13:00:00.000Z',
          frequency: 'WEEKLY',
          occurrences: 3,
        })
        .expect(402);
    });

    /**
     * La regla: se corta crear valor nuevo, no operar lo que ya existe. Un
     * negocio que debe tiene que poder seguir atendiendo a su clientela, que no
     * tiene nada que ver con la cobranza.
     */
    describe('lo que sigue funcionando aunque deba', () => {
      it('ver la agenda', async () => {
        await overdueBy(GRACE_DAYS + 30);

        await request(server())
          .get('/appointments?from=2026-09-01&to=2026-09-30')
          .set(...auth(tenant.accessToken))
          .expect(200);
      });

      it('cancelar y reprogramar un turno que ya estaba', async () => {
        const ctx = await overdueBy(2);

        const turno = await book(ctx, '2026-09-07T13:00:00.000Z').expect(201);
        const id = (turno.body as { id: string }).id;

        await periodEndedDaysAgo(GRACE_DAYS + 10);

        await request(server())
          .post(`/appointments/${id}/reschedule`)
          .set(...auth(tenant.accessToken))
          .send({ startsAt: '2026-09-07T15:00:00.000Z' })
          .expect(201);
      });

      it('pagar la suscripción, que es lo que lo destraba', async () => {
        await overdueBy(GRACE_DAYS + 10);

        await checkout().expect(201);
      });
    });

    it('pagar destraba el alta de turnos', async () => {
      const ctx = await overdueBy(GRACE_DAYS + 1);

      await book(ctx, '2026-09-07T13:00:00.000Z').expect(402);

      await checkout().expect(201);
      await notify(sandbox.lastPaymentId()).expect(200);

      await book(ctx, '2026-09-07T13:00:00.000Z').expect(201);
    });
  });
});
