import {
  BadGatewayException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentStatus, type Prisma, SubscriptionStatus } from '@prisma/client';
import { TenantContextService } from '../../common/tenant-context';
import type { Env } from '../../config/env.schema';
import { PrismaService } from '../../prisma/prisma.service';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
  type ProviderPayment,
} from '../payments/providers/payment-provider.types';
import type {
  SubscriptionCheckoutDto,
  SubscriptionDto,
} from './dto/subscription.dto';
import {
  blocksNewBookings,
  daysOverdue,
  nextPeriod,
} from './subscription-lifecycle';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Lo que sale en el historial. **Sin `checkoutUrl`**: es un link de pago vivo y
 * no tiene por qué viajar en una lista que se pide para mirar.
 */
const PAYMENT_SELECT = {
  id: true,
  amountCents: true,
  currency: true,
  status: true,
  periodStart: true,
  periodEnd: true,
  paidAt: true,
  failureReason: true,
  createdAt: true,
} satisfies Prisma.SubscriptionPaymentSelect;

/** El mismo, más el link: solo lo necesita el reuso del checkout. */
const PAYMENT_WITH_CHECKOUT_SELECT = {
  ...PAYMENT_SELECT,
  checkoutUrl: true,
} satisfies Prisma.SubscriptionPaymentSelect;

const SUBSCRIPTION_SELECT = {
  id: true,
  status: true,
  currentPeriodStart: true,
  currentPeriodEnd: true,
  tenantId: true,
  plan: {
    select: { id: true, name: true, slug: true, priceMonthlyCents: true },
  },
} satisfies Prisma.SubscriptionSelect;

type SubscriptionRow = Prisma.SubscriptionGetPayload<{
  select: typeof SUBSCRIPTION_SELECT;
}>;

/**
 * La suscripción del negocio a AgendApp: en qué estado está, cómo se paga el
 * mes y cuándo se le corta el servicio al que no paga.
 *
 * **Ojo con el espejo.** `Subscription.status` y `Tenant.subscriptionStatus`
 * guardan lo mismo: la columna del tenant existe porque `/auth/me` la lee en
 * cada request y no vale la pena un join para eso. Hay exactamente **dos**
 * lugares que cambian el estado —`applyPayment` cuando se acredita un cobro y
 * `expireLapsed` cuando vence el período— y los dos escriben **las dos columnas
 * dentro de la misma transacción**. Esa es la regla que hay que sostener: si
 * alguna vez se tocan por separado, queda una ventana donde la app muestra un
 * estado y bloquea por otro.
 *
 * Lo que **no** hace: débito automático. Cobrar solos todos los meses es la
 * API de preapproval de Mercado Pago, que es una integración aparte de la del
 * checkout. Hoy el mes se paga con un link, igual que una seña.
 */
@Injectable()
export class SubscriptionsService {
  private readonly logger = new Logger(SubscriptionsService.name);

  private readonly graceDays: number;
  private readonly appBaseUrl: string;
  private readonly apiPublicUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    config: ConfigService<Env, true>,
  ) {
    this.graceDays = config.get('SUBSCRIPTION_GRACE_DAYS', { infer: true });
    this.appBaseUrl = config
      .get('APP_BASE_URL', { infer: true })
      .replace(/\/+$/, '');
    this.apiPublicUrl = config
      .get('API_PUBLIC_URL', { infer: true })
      .replace(/\/+$/, '');
  }

  /** Estado, plan, período y el historial de cobros. */
  async findCurrent(): Promise<SubscriptionDto> {
    const subscription = await this.currentOrFail();
    const now = new Date();

    const payments = await this.prisma.scoped.subscriptionPayment.findMany({
      where: { subscriptionId: subscription.id },
      select: PAYMENT_SELECT,
      orderBy: { createdAt: 'desc' },
    });

    return {
      status: subscription.status,
      plan: subscription.plan,
      currentPeriodStart: subscription.currentPeriodStart,
      currentPeriodEnd: subscription.currentPeriodEnd,
      daysOverdue: daysOverdue(subscription.currentPeriodEnd, now),
      blocked: blocksNewBookings(subscription, now, this.graceDays),
      graceDays: this.graceDays,
      payments,
    };
  }

  /**
   * El link para pagar el mes.
   *
   * Mismo orden que en los cobros de turnos y por el mismo motivo: primero la
   * fila, después el proveedor. El id de la fila es la referencia que vuelve en
   * el aviso.
   */
  async createCheckout(): Promise<SubscriptionCheckoutDto> {
    const subscription = await this.currentOrFail();
    const price = subscription.plan.priceMonthlyCents;

    if (price === null || price <= 0) {
      throw new ConflictException(
        `El plan ${subscription.plan.name} se cotiza con soporte: no se puede pagar desde el panel`,
      );
    }

    const period = nextPeriod(
      subscription.currentPeriodEnd,
      new Date(),
      this.graceDays,
    );

    const existing = await this.prisma.scoped.subscriptionPayment.findFirst({
      where: {
        subscriptionId: subscription.id,
        status: PaymentStatus.PENDING,
        periodStart: period.start,
        amountCents: price,
        checkoutUrl: { not: null },
      },
      select: PAYMENT_WITH_CHECKOUT_SELECT,
    });

    // Pedir el link dos veces no genera dos cobros del mismo mes.
    if (existing?.checkoutUrl) {
      return {
        paymentId: existing.id,
        checkoutUrl: existing.checkoutUrl,
        amountCents: existing.amountCents,
        currency: existing.currency,
        periodStart: existing.periodStart,
        periodEnd: existing.periodEnd,
        reused: true,
      };
    }

    const currency = await this.tenantCurrency(subscription.tenantId);

    const created = await this.prisma.scoped.subscriptionPayment.create({
      data: {
        tenantId: subscription.tenantId,
        subscriptionId: subscription.id,
        amountCents: price,
        currency,
        status: PaymentStatus.PENDING,
        periodStart: period.start,
        periodEnd: period.end,
      },
      select: { id: true },
    });

    let session;

    try {
      session = await this.provider.createCheckout({
        reference: created.id,
        title: `AgendApp — Plan ${subscription.plan.name}`,
        amountCents: price,
        currency,
        successUrl: `${this.appBaseUrl}/suscripcion/exito`,
        failureUrl: `${this.appBaseUrl}/suscripcion/error`,
        pendingUrl: `${this.appBaseUrl}/suscripcion/pendiente`,
        notificationUrl: `${this.apiPublicUrl}/webhooks/mercadopago`,
      });
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : 'Error desconocido';

      await this.prisma.scoped.subscriptionPayment.update({
        where: { id: created.id },
        data: { status: PaymentStatus.FAILED, failureReason: reason },
      });

      this.logger.error(
        { paymentId: created.id, err: reason },
        'No se pudo crear el checkout de la suscripción',
      );

      throw new BadGatewayException(
        'No se pudo generar el link de pago. Intentá de nuevo en un rato.',
      );
    }

    await this.prisma.scoped.subscriptionPayment.update({
      where: { id: created.id },
      data: {
        mpPreferenceId: session.providerCheckoutId,
        checkoutUrl: session.checkoutUrl,
      },
    });

    return {
      paymentId: created.id,
      checkoutUrl: session.checkoutUrl,
      amountCents: price,
      currency,
      periodStart: period.start,
      periodEnd: period.end,
      reused: false,
    };
  }

  /**
   * Aplica un aviso del proveedor si el pago era de una suscripción.
   *
   * Devuelve `false` cuando el pago no es de acá, para que quien rutea el
   * webhook siga buscando. Corre **sin contexto de tenant**: lo llama el
   * endpoint público, y el `tenantId` sale de la fila.
   */
  async applyWebhookPayment(
    providerPayment: ProviderPayment,
  ): Promise<boolean> {
    const target = await this.locatePayment(providerPayment);

    if (!target) {
      return false;
    }

    await this.tenantContext.run({ tenantId: target.tenantId }, async () => {
      await this.applyPayment(target.id, providerPayment);
    });

    return true;
  }

  /**
   * Marca como vencidas las suscripciones cuyo período terminó.
   *
   * **Es idempotente**, y eso no es prolijidad: `@nestjs/schedule` corre el cron
   * en **cada instancia** de la app, así que con dos réplicas esto se ejecuta
   * dos veces. Al pasar de `TRIAL`/`ACTIVE` a `PAST_DUE`, la segunda corrida ya
   * no encuentra nada. Un lock de un solo runner es trabajo de la cola (Fase 8).
   */
  async expireLapsed(now = new Date()): Promise<number> {
    return this.tenantContext.runWithoutTenant(async () => {
      const lapsed = await this.prisma.subscription.findMany({
        where: {
          status: {
            in: [SubscriptionStatus.TRIAL, SubscriptionStatus.ACTIVE],
          },
          currentPeriodEnd: { lte: now },
          tenant: { deletedAt: null },
        },
        select: { id: true, tenantId: true },
      });

      if (lapsed.length === 0) {
        return 0;
      }

      await this.prisma.$transaction([
        this.prisma.subscription.updateMany({
          where: { id: { in: lapsed.map((row) => row.id) } },
          data: { status: SubscriptionStatus.PAST_DUE },
        }),
        // El espejo del tenant, en la misma transacción: separarlos deja una
        // ventana donde la app muestra un estado y bloquea por otro.
        this.prisma.tenant.updateMany({
          where: { id: { in: lapsed.map((row) => row.tenantId) } },
          data: { subscriptionStatus: SubscriptionStatus.PAST_DUE },
        }),
      ]);

      this.logger.log(
        { count: lapsed.length },
        'Suscripciones vencidas pasadas a PAST_DUE',
      );

      return lapsed.length;
    });
  }

  /**
   * Si el negocio ya no puede agendar. Lo consulta el guard en cada alta de
   * turno, así que se lee lo mínimo.
   *
   * Sin suscripción **no se bloquea**: un negocio sin fila es un bug de datos,
   * y castigar a quien lo sufre por un error nuestro es la peor respuesta.
   */
  async isBlocked(tenantId: string): Promise<boolean> {
    const subscription = await this.tenantContext.runWithoutTenant(async () =>
      this.prisma.subscription.findFirst({
        where: { tenantId },
        select: { status: true, currentPeriodEnd: true },
        orderBy: { createdAt: 'desc' },
      }),
    );

    if (!subscription) {
      return false;
    }

    return blocksNewBookings(subscription, new Date(), this.graceDays);
  }

  // ── Interno ───────────────────────────────────────────────────────────────

  /**
   * Escribe el estado del pago y, si se acreditó, renueva el período.
   *
   * Idempotente: el mismo aviso repetido escribe los mismos valores, y la
   * renovación se guarda con `periodEnd` de la fila —no calculado de nuevo—
   * así que aplicarla dos veces deja el mismo resultado en vez de correr el
   * vencimiento un mes más cada vez.
   */
  private async applyPayment(
    paymentId: string,
    providerPayment: ProviderPayment,
  ): Promise<void> {
    await this.prisma.scoped.$transaction(async (tx) => {
      const payment = await tx.subscriptionPayment.update({
        where: { id: paymentId },
        data: {
          status: providerPayment.status,
          paidAt: providerPayment.paidAt,
          mpPaymentId: providerPayment.providerPaymentId,
          failureReason: providerPayment.failureReason,
        },
        select: {
          subscriptionId: true,
          periodStart: true,
          periodEnd: true,
          tenantId: true,
        },
      });

      if (providerPayment.status !== PaymentStatus.SUCCEEDED) {
        return;
      }

      await tx.subscription.update({
        where: { id: payment.subscriptionId },
        data: {
          status: SubscriptionStatus.ACTIVE,
          currentPeriodStart: payment.periodStart,
          currentPeriodEnd: payment.periodEnd,
        },
      });

      await tx.tenant.update({
        where: { id: payment.tenantId },
        data: { subscriptionStatus: SubscriptionStatus.ACTIVE },
      });
    });

    this.logger.log(
      { paymentId, status: providerPayment.status },
      'Cobro de suscripción actualizado desde el proveedor',
    );
  }

  private locatePayment(
    providerPayment: ProviderPayment,
  ): Promise<{ id: string; tenantId: string } | null> {
    return this.tenantContext.runWithoutTenant(async () => {
      const byProviderId = await this.prisma.subscriptionPayment.findUnique({
        where: { mpPaymentId: providerPayment.providerPaymentId },
        select: { id: true, tenantId: true },
      });

      if (byProviderId) {
        return byProviderId;
      }

      if (
        !providerPayment.reference ||
        !UUID_PATTERN.test(providerPayment.reference)
      ) {
        return null;
      }

      return this.prisma.subscriptionPayment.findUnique({
        where: { id: providerPayment.reference },
        select: { id: true, tenantId: true },
      });
    });
  }

  private async currentOrFail(): Promise<SubscriptionRow> {
    const subscription = await this.prisma.scoped.subscription.findFirst({
      select: SUBSCRIPTION_SELECT,
      orderBy: { createdAt: 'desc' },
    });

    if (!subscription) {
      throw new NotFoundException('El negocio no tiene una suscripción');
    }

    return subscription;
  }

  private async tenantCurrency(tenantId: string): Promise<string> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { currency: true },
    });

    return tenant?.currency ?? 'ARS';
  }
}
