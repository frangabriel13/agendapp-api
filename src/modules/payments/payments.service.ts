import {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AppointmentPaymentType,
  AppointmentStatus,
  PaymentMethod,
  PaymentStatus,
  type Prisma,
} from '@prisma/client';
import { TenantContextService } from '../../common/tenant-context';
import type { Env } from '../../config/env.schema';
import { scopedCreate } from '../../prisma/extensions';
import {
  PrismaService,
  type ScopedTransactionClient,
} from '../../prisma/prisma.service';
import { AppointmentsService } from '../appointments/appointments.service';
import { isCanceled } from '../appointments/status-machine';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import type { AuthenticatedUser } from '../auth/types/jwt-payload';
import { appointmentBalance, type AppointmentBalance } from './payment-balance';
import type {
  AppointmentPaymentsDto,
  CheckoutPaymentType,
  CheckoutResponseDto,
  CreateCheckoutDto,
  PaymentResponseDto,
  RecordManualPaymentDto,
  WebhookResultDto,
} from './dto/payment.dto';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
  PaymentProviderError,
  type ProviderPayment,
  type WebhookRequest,
} from './providers/payment-provider.types';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const PAYMENT_SELECT = {
  id: true,
  amountCents: true,
  currency: true,
  paymentType: true,
  paymentMethod: true,
  status: true,
  notes: true,
  failureReason: true,
  checkoutUrl: true,
  paidAt: true,
  createdAt: true,
  recordedBy: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.AppointmentPaymentSelect;

type PaymentRow = Prisma.AppointmentPaymentGetPayload<{
  select: typeof PAYMENT_SELECT;
}>;

/** Lo que hace falta del turno para cobrarle algo. */
const APPOINTMENT_SELECT = {
  id: true,
  status: true,
  totalPriceCents: true,
  depositAmountCents: true,
  customer: { select: { firstName: true, lastName: true, email: true } },
  services: { select: { service: { select: { name: true } } } },
} satisfies Prisma.AppointmentSelect;

type ChargeableAppointment = Prisma.AppointmentGetPayload<{
  select: typeof APPOINTMENT_SELECT;
}>;

function toPaymentResponse(row: PaymentRow): PaymentResponseDto {
  return { ...row };
}

/**
 * Cobros de turnos: el link de pago, el aviso del proveedor y la carga manual.
 *
 * Dos reglas atraviesan todo el archivo:
 *
 * 1. **El saldo no se guarda, se calcula.** Cada vez que hace falta saber
 *    cuánto se pagó, sale de `appointmentBalance()` sobre las filas. Lo único
 *    que se persiste es `Appointment.depositPaid`, y lo escribe un solo lugar
 *    (`AppointmentsService.syncPaymentState`).
 * 2. **El estado de un pago nunca viene del aviso.** El webhook trae un id; qué
 *    pasó con ese pago se le pregunta al proveedor.
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  private readonly appBaseUrl: string;
  private readonly apiPublicUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly appointments: AppointmentsService,
    private readonly subscriptions: SubscriptionsService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    config: ConfigService<Env, true>,
  ) {
    this.appBaseUrl = config
      .get('APP_BASE_URL', { infer: true })
      .replace(/\/+$/, '');
    this.apiPublicUrl = config
      .get('API_PUBLIC_URL', { infer: true })
      .replace(/\/+$/, '');
  }

  /** Los pagos de un turno y el saldo que dejan. */
  async findForAppointment(
    appointmentId: string,
  ): Promise<AppointmentPaymentsDto> {
    const appointment = await this.findAppointmentOrFail(appointmentId);
    const payments = await this.paymentsOf(appointmentId);

    return {
      balance: this.buildBalance(appointment, payments),
      payments: payments.map(toPaymentResponse),
    };
  }

  /**
   * Arma el link de pago.
   *
   * El orden importa y no es arbitrario: **primero se crea la fila, después se
   * llama al proveedor**. El id de la fila es lo que viaja como referencia y es
   * lo único que permite, cuando llegue el aviso, saber qué se estaba cobrando.
   * Al revés habría un checkout vivo sin nada de nuestro lado que lo espere.
   *
   * Si el proveedor falla, la fila queda marcada como fallida con el motivo:
   * borrarla escondería que hubo un intento.
   */
  async createCheckout(
    appointmentId: string,
    dto: CreateCheckoutDto,
  ): Promise<CheckoutResponseDto> {
    const appointment = await this.findAppointmentOrFail(appointmentId);

    this.assertChargeable(appointment);

    const payments = await this.paymentsOf(appointmentId);
    const balance = this.buildBalance(appointment, payments);
    const paymentType = dto.paymentType ?? this.defaultChargeType(balance);
    const amountCents = this.amountFor(appointment, balance, paymentType);

    if (amountCents <= 0) {
      throw new ConflictException(
        'No hay nada que cobrar: el turno ya está pago',
      );
    }

    const reusable = payments.find(
      (payment) =>
        payment.status === PaymentStatus.PENDING &&
        payment.paymentMethod === PaymentMethod.MERCADOPAGO &&
        payment.paymentType === paymentType &&
        payment.amountCents === amountCents &&
        payment.checkoutUrl !== null,
    );

    // Pedir dos veces el mismo cobro devuelve el mismo link. Sin esto, cada
    // clic en "pagar" dejaría otra fila pendiente y otro checkout vivo, y el
    // cliente podría terminar pagando dos veces la misma seña.
    if (reusable?.checkoutUrl) {
      return {
        paymentId: reusable.id,
        checkoutUrl: reusable.checkoutUrl,
        amountCents: reusable.amountCents,
        currency: reusable.currency,
        paymentType: reusable.paymentType,
        reused: true,
      };
    }

    const currency = await this.tenantCurrency();

    const created = await this.prisma.scoped.appointmentPayment.create({
      data: scopedCreate<Prisma.AppointmentPaymentUncheckedCreateInput>({
        appointmentId,
        amountCents,
        currency,
        paymentType,
        paymentMethod: PaymentMethod.MERCADOPAGO,
        status: PaymentStatus.PENDING,
      }),
      select: { id: true },
    });

    const session = await this.openCheckout(created.id, {
      appointment,
      amountCents,
      currency,
      paymentType,
    });

    await this.prisma.scoped.appointmentPayment.update({
      where: { id: created.id },
      data: {
        mpPreferenceId: session.providerCheckoutId,
        checkoutUrl: session.checkoutUrl,
      },
    });

    return {
      paymentId: created.id,
      checkoutUrl: session.checkoutUrl,
      amountCents,
      currency,
      paymentType,
      reused: false,
    };
  }

  /**
   * Registra plata que entró (o salió) por fuera del proveedor: efectivo,
   * transferencia, o una devolución hecha en el mostrador.
   *
   * Nace acreditada, porque quien la carga la está viendo. Por eso queda
   * asentado **quién** la cargó: es el único rastro de un movimiento que ningún
   * sistema externo puede confirmar.
   */
  async recordManual(
    appointmentId: string,
    dto: RecordManualPaymentDto,
    user: AuthenticatedUser,
  ): Promise<PaymentResponseDto> {
    const appointment = await this.findAppointmentOrFail(appointmentId);

    this.assertChargeable(appointment);

    const currency = await this.tenantCurrency();

    const payment = await this.prisma.scoped.$transaction(async (tx) => {
      const created = await tx.appointmentPayment.create({
        data: scopedCreate<Prisma.AppointmentPaymentUncheckedCreateInput>({
          appointmentId,
          amountCents: dto.amountCents,
          currency,
          paymentType: dto.paymentType,
          paymentMethod: dto.paymentMethod,
          status: PaymentStatus.SUCCEEDED,
          paidAt: new Date(),
          notes: dto.notes ?? null,
          recordedByUserId: user.userId,
        }),
        select: PAYMENT_SELECT,
      });

      await this.refreshAppointment(tx, appointment, appointmentId);

      return created;
    });

    return toPaymentResponse(payment);
  }

  /**
   * El aviso del proveedor.
   *
   * Corre **sin contexto de tenant**: es un endpoint público y no hay token que
   * lo resuelva. La fila del pago se busca con el cliente base (la referencia
   * es un UUID nuestro, no hay nada que filtrar), y de ahí sale el `tenantId`
   * con el que se monta el contexto para el resto — así el service de turnos
   * sigue trabajando scopeado, sin saber que lo llamó un webhook.
   */
  async handleWebhook(request: WebhookRequest): Promise<WebhookResultDto> {
    // Lo primero, y antes de tocar la base: sin esto el endpoint es un lugar
    // público donde cualquiera avisa "este turno ya se pagó". Un aviso que no
    // verifica no se procesa ni para dejarlo anotado.
    if (!this.provider.verifyWebhookSignature(request)) {
      this.logger.warn(
        { query: request.query },
        'Aviso de pago con firma inválida: descartado',
      );

      throw new UnauthorizedException('Firma inválida');
    }

    const providerPaymentId = this.provider.paymentIdFromWebhook(request);

    if (!providerPaymentId) {
      return { result: 'ignored' };
    }

    let providerPayment: ProviderPayment;

    try {
      providerPayment = await this.provider.getPayment(providerPaymentId);
    } catch (error) {
      // Que el proveedor no conteste NO es un aviso inválido: hay que dejar que
      // reintente, y para eso la respuesta tiene que ser un error.
      this.logger.error(
        { providerPaymentId, err: String(error) },
        'No se pudo consultar el pago al proveedor',
      );

      throw new BadGatewayException(
        error instanceof PaymentProviderError
          ? error.message
          : 'No se pudo consultar el pago al proveedor',
      );
    }

    const target = await this.locatePayment(providerPayment);

    if (!target) {
      // El aviso no dice de qué cobro es, así que si no está entre los pagos de
      // turnos hay que probar con los de suscripción antes de darlo por ajeno.
      if (await this.subscriptions.applyWebhookPayment(providerPayment)) {
        return { result: 'applied' };
      }

      // Un pago que no es nuestro, o una fila que ya no existe. Se contesta 200:
      // reintentarlo no va a cambiar nada y solo genera ruido.
      this.logger.warn(
        { providerPaymentId, reference: providerPayment.reference },
        'Aviso de un pago que no está en la base',
      );

      return { result: 'unknown_payment' };
    }

    await this.tenantContext.run({ tenantId: target.tenantId }, async () => {
      await this.applyProviderPayment(
        target.id,
        target.appointmentId,
        providerPayment,
      );
    });

    return { result: 'applied' };
  }

  // ── Interno ───────────────────────────────────────────────────────────────

  /**
   * Escribe el estado que dijo el proveedor y actualiza el turno, todo junto.
   *
   * Es idempotente a propósito: el mismo aviso repetido escribe los mismos
   * valores y vuelve a calcular el mismo saldo. MP entrega los avisos varias
   * veces y desordenados, así que esto **va a** correr dos veces.
   */
  private async applyProviderPayment(
    paymentId: string,
    appointmentId: string,
    providerPayment: ProviderPayment,
  ): Promise<void> {
    await this.prisma.scoped.$transaction(async (tx) => {
      await tx.appointmentPayment.update({
        where: { id: paymentId },
        data: {
          status: providerPayment.status,
          paidAt: providerPayment.paidAt,
          mpPaymentId: providerPayment.providerPaymentId,
          failureReason: providerPayment.failureReason,
        },
      });

      const appointment = await tx.appointment.findFirst({
        where: { id: appointmentId },
        select: APPOINTMENT_SELECT,
      });

      if (appointment) {
        await this.refreshAppointment(tx, appointment, appointmentId);
      }
    });

    this.logger.log(
      {
        paymentId,
        appointmentId,
        status: providerPayment.status,
        rawStatus: providerPayment.rawStatus,
      },
      'Pago actualizado desde el proveedor',
    );
  }

  /**
   * Recalcula el saldo con las filas ya escritas y se lo pasa al service de
   * turnos, que es el único que toca el estado de un turno.
   */
  private async refreshAppointment(
    tx: ScopedTransactionClient,
    appointment: { totalPriceCents: number; depositAmountCents: number | null },
    appointmentId: string,
  ): Promise<void> {
    const payments = await tx.appointmentPayment.findMany({
      where: { appointmentId },
      select: { amountCents: true, paymentType: true, status: true },
    });

    const balance = appointmentBalance(appointment, payments);

    await this.appointments.syncPaymentState(
      tx,
      appointmentId,
      balance.depositCovered,
    );
  }

  /**
   * Encuentra nuestra fila para un pago del proveedor, **sin contexto de
   * tenant**.
   *
   * Se busca primero por `mpPaymentId` (el aviso repetido, que es el caso más
   * común) y después por la referencia que mandamos al crear el checkout.
   */
  private async locatePayment(
    providerPayment: ProviderPayment,
  ): Promise<{ id: string; tenantId: string; appointmentId: string } | null> {
    return this.tenantContext.runWithoutTenant(async () => {
      const byProviderId = await this.prisma.appointmentPayment.findUnique({
        where: { mpPaymentId: providerPayment.providerPaymentId },
        select: { id: true, tenantId: true, appointmentId: true },
      });

      if (byProviderId) {
        return byProviderId;
      }

      // La referencia tiene que parecer un id nuestro antes de ir a buscarla:
      // Postgres rechaza un UUID mal formado con un error, y eso saldría como
      // 500 en vez de "ese pago no es nuestro".
      if (
        !providerPayment.reference ||
        !UUID_PATTERN.test(providerPayment.reference)
      ) {
        return null;
      }

      return this.prisma.appointmentPayment.findUnique({
        where: { id: providerPayment.reference },
        select: { id: true, tenantId: true, appointmentId: true },
      });
    });
  }

  /** Le pide el checkout al proveedor y deja rastro si se cae. */
  private async openCheckout(
    paymentId: string,
    context: {
      appointment: ChargeableAppointment;
      amountCents: number;
      currency: string;
      paymentType: CheckoutPaymentType;
    },
  ) {
    try {
      return await this.provider.createCheckout({
        reference: paymentId,
        title: this.checkoutTitle(context.appointment, context.paymentType),
        amountCents: context.amountCents,
        currency: context.currency,
        payerEmail: context.appointment.customer.email ?? undefined,
        successUrl: `${this.appBaseUrl}/pago/exito`,
        failureUrl: `${this.appBaseUrl}/pago/error`,
        pendingUrl: `${this.appBaseUrl}/pago/pendiente`,
        notificationUrl: `${this.apiPublicUrl}/webhooks/mercadopago`,
      });
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : 'Error desconocido';

      await this.prisma.scoped.appointmentPayment.update({
        where: { id: paymentId },
        data: { status: PaymentStatus.FAILED, failureReason: reason },
      });

      this.logger.error(
        { paymentId, err: reason },
        'No se pudo crear el checkout',
      );

      throw new BadGatewayException(
        'No se pudo generar el link de pago. Intentá de nuevo en un rato.',
      );
    }
  }

  private checkoutTitle(
    appointment: ChargeableAppointment,
    paymentType: CheckoutPaymentType,
  ): string {
    const label: Record<CheckoutPaymentType, string> = {
      [AppointmentPaymentType.DEPOSIT]: 'Seña',
      [AppointmentPaymentType.FULL]: 'Pago',
      [AppointmentPaymentType.REMAINDER]: 'Saldo',
    };

    const services = appointment.services
      .map((row) => row.service.name)
      .join(' + ');

    return services
      ? `${label[paymentType]} — ${services}`
      : label[paymentType];
  }

  /**
   * Qué se cobra cuando no lo dicen: la seña si el turno tiene una y todavía no
   * está cubierta, el saldo en cualquier otro caso.
   */
  private defaultChargeType(balance: AppointmentBalance): CheckoutPaymentType {
    return balance.depositCovered
      ? AppointmentPaymentType.REMAINDER
      : AppointmentPaymentType.DEPOSIT;
  }

  private amountFor(
    appointment: ChargeableAppointment,
    balance: AppointmentBalance,
    paymentType: CheckoutPaymentType,
  ): number {
    switch (paymentType) {
      case AppointmentPaymentType.DEPOSIT:
        if (appointment.depositAmountCents === null) {
          throw new BadRequestException('Este turno no tiene seña configurada');
        }

        return appointment.depositAmountCents - Math.max(0, balance.paidCents);

      case AppointmentPaymentType.FULL:
        return appointment.totalPriceCents;

      case AppointmentPaymentType.REMAINDER:
        return balance.dueCents;
    }
  }

  private buildBalance(
    appointment: { totalPriceCents: number; depositAmountCents: number | null },
    payments: readonly PaymentRow[],
  ) {
    return {
      totalPriceCents: appointment.totalPriceCents,
      depositAmountCents: appointment.depositAmountCents,
      ...appointmentBalance(appointment, payments),
    };
  }

  /** Un turno cancelado o reprogramado ya no admite movimientos de plata. */
  private assertChargeable(appointment: ChargeableAppointment): void {
    if (
      isCanceled(appointment.status) ||
      appointment.status === AppointmentStatus.RESCHEDULED
    ) {
      throw new ConflictException(
        'El turno está cancelado o fue reprogramado: no se le pueden registrar pagos',
      );
    }
  }

  private paymentsOf(appointmentId: string): Promise<PaymentRow[]> {
    return this.prisma.scoped.appointmentPayment.findMany({
      where: { appointmentId },
      select: PAYMENT_SELECT,
      orderBy: { createdAt: 'asc' },
    });
  }

  private async findAppointmentOrFail(
    id: string,
  ): Promise<ChargeableAppointment> {
    const appointment = await this.prisma.scoped.appointment.findFirst({
      where: { id },
      select: APPOINTMENT_SELECT,
    });

    if (!appointment) {
      throw new NotFoundException('El turno no existe');
    }

    return appointment;
  }

  /** La moneda se congela en cada pago, copiada del negocio. */
  private async tenantCurrency(): Promise<string> {
    const tenantId = this.tenantContext.getTenantId();

    const tenant = tenantId
      ? await this.prisma.tenant.findUnique({
          where: { id: tenantId },
          select: { currency: true },
        })
      : null;

    return tenant?.currency ?? 'ARS';
  }
}
