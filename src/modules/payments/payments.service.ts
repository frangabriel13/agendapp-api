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
import {
  paginationMeta,
  resolvePagination,
} from '../../common/dto/pagination.dto';
import { TenantContextService } from '../../common/tenant-context';
import { parseDateOnly } from '../../common/utils/date-only.util';
import {
  MINUTES_PER_DAY,
  zonedWallTimeToUtc,
} from '../../common/utils/timezone.util';
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
import {
  appointmentBalance,
  paymentTotals,
  type AppointmentBalance,
} from './payment-balance';
import {
  MAX_RECEIVABLES_RANGE_DAYS,
  OWING_APPOINTMENT_STATUSES,
  type PaymentReceivablesQueryDto,
  type PaymentReceivablesResponseDto,
  type ReceivableItemDto,
  type ReceivablesTotalsDto,
} from './dto/payment-receivables.dto';
import type {
  PaymentRangeItemDto,
  PaymentRangeQueryDto,
  PaymentRangeResponseDto,
  PaymentRangeTotalsDto,
  SettledPaymentStatus,
} from './dto/payment-range.dto';
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
 * Lo que muestra una fila del listado por rango.
 *
 * No trae `checkoutUrl` a propósito: ese link es para el cliente que tiene que
 * pagar, no para un reporte de caja, y estas filas ya están acreditadas.
 */
const RANGE_SELECT = {
  id: true,
  amountCents: true,
  currency: true,
  paymentType: true,
  paymentMethod: true,
  status: true,
  notes: true,
  paidAt: true,
  recordedBy: { select: { id: true, firstName: true, lastName: true } },
  appointment: {
    select: {
      id: true,
      startsAt: true,
      customer: { select: { firstName: true, lastName: true } },
      employee: {
        select: { user: { select: { firstName: true, lastName: true } } },
      },
      branch: { select: { name: true } },
    },
  },
} satisfies Prisma.AppointmentPaymentSelect;

type RangeRow = Prisma.AppointmentPaymentGetPayload<{
  select: typeof RANGE_SELECT;
}>;

function toRangeItem(row: RangeRow): PaymentRangeItemDto {
  const { appointment } = row;

  return {
    id: row.id,
    amountCents: row.amountCents,
    currency: row.currency,
    paymentType: row.paymentType,
    paymentMethod: row.paymentMethod,
    // Las dos son seguras por construcción: el filtro es por `paidAt`, y una
    // fila sin fecha de acreditación no puede estar en el resultado. Por lo
    // mismo su estado solo puede ser SUCCEEDED o REFUNDED.
    status: row.status as SettledPaymentStatus,
    paidAt: row.paidAt!,
    notes: row.notes,
    recordedBy: row.recordedBy,
    appointment: {
      id: appointment.id,
      startsAt: appointment.startsAt,
      customerName: `${appointment.customer.firstName} ${appointment.customer.lastName}`,
      employeeName: `${appointment.employee.user.firstName} ${appointment.employee.user.lastName}`,
      branchName: appointment.branch.name,
    },
  };
}

const RECEIVABLE_SELECT = {
  id: true,
  startsAt: true,
  status: true,
  totalPriceCents: true,
  depositAmountCents: true,
  customer: { select: { firstName: true, lastName: true, phone: true } },
  employee: {
    select: { user: { select: { firstName: true, lastName: true } } },
  },
  branch: { select: { name: true } },
  // El saldo no se guarda: sale de estas filas, por `appointmentBalance`.
  payments: { select: { amountCents: true, paymentType: true, status: true } },
} satisfies Prisma.AppointmentSelect;

type ReceivableRow = Prisma.AppointmentGetPayload<{
  select: typeof RECEIVABLE_SELECT;
}>;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Suma la deuda del rango entero.
 *
 * No hay `groupBy` posible: `dueCents` es por turno y ya viene calculado por
 * `appointmentBalance`, así que esto solo lo acumula. La regla de qué pago
 * suma y qué pago resta sigue viviendo en un solo lugar.
 */
function receivablesTotals(
  items: readonly ReceivableItemDto[],
): ReceivablesTotalsDto {
  return items.reduce<ReceivablesTotalsDto>(
    (totals, item) => ({
      appointments: totals.appointments + 1,
      totalPriceCents: totals.totalPriceCents + item.totalPriceCents,
      paidCents: totals.paidCents + item.paidCents,
      dueCents: totals.dueCents + item.dueCents,
    }),
    { appointments: 0, totalPriceCents: 0, paidCents: 0, dueCents: 0 },
  );
}

function toReceivable(row: ReceivableRow, currency: string): ReceivableItemDto {
  const balance = appointmentBalance(row, row.payments);

  return {
    appointmentId: row.id,
    startsAt: row.startsAt,
    status: row.status,
    customerName: `${row.customer.firstName} ${row.customer.lastName}`,
    customerPhone: row.customer.phone,
    employeeName: `${row.employee.user.firstName} ${row.employee.user.lastName}`,
    branchName: row.branch.name,
    currency,
    totalPriceCents: row.totalPriceCents,
    depositAmountCents: row.depositAmountCents,
    paidCents: balance.paidCents,
    refundedCents: balance.refundedCents,
    dueCents: balance.dueCents,
    depositCovered: balance.depositCovered,
  };
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

    // Una devolución es lo que pasa **después** de cancelar, así que no puede
    // caer bajo la misma regla que un cobro. Bloqueándola, la API calculaba
    // cuánto correspondía devolver (`refund` en la respuesta de la cancelación)
    // y después se negaba a asentarlo: la plata volvía por el mostrador y no
    // quedaba registrada en ningún lado.
    if (dto.paymentType !== AppointmentPaymentType.REFUND) {
      this.assertChargeable(appointment);
    }

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

  /**
   * Un turno cancelado o reprogramado ya no admite que le **entre** plata.
   *
   * Ojo con el nombre: es "cobrable", no "movible". Las devoluciones quedan
   * afuera de esta regla a propósito y su caller las saltea — ver `recordManual`.
   */
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

  /**
   * Los cobros acreditados en un rango de días, con los totales del rango.
   *
   * **Devuelve plata liquidada, no el estado de cobranza del mes.** El filtro
   * es por `paidAt` —cuándo entró la plata, no cuándo se creó la fila—, así
   * que un cobro pendiente o fallado no aparece nunca: no tiene esa fecha. Lo
   * que falta cobrar de un turno sale de su saldo
   * (`GET /appointments/:id/payments`), no de contar filas pendientes acá.
   *
   * Un matiz que conviene saber antes de conciliar: **esto refleja el estado
   * de hoy de los pagos de ese período, no una foto congelada.** Si un cobro
   * de septiembre lo revierte el proveedor en octubre, el reporte de
   * septiembre pasa a mostrarlo revertido — su `paidAt` sigue siendo el de
   * septiembre. Es lo correcto para "cuánto entró", pero significa que el
   * mismo rango puede dar distinto en dos momentos.
   */
  async findByRange(
    query: PaymentRangeQueryDto,
  ): Promise<PaymentRangeResponseDto> {
    const where = await this.rangeFilter(query);
    const { page, pageSize, skip, take } = resolvePagination(query);

    const [rows, total, totals] = await Promise.all([
      this.prisma.scoped.appointmentPayment.findMany({
        where,
        select: RANGE_SELECT,
        // Lo más reciente primero, y el id desempata: sin un segundo criterio,
        // dos cobros del mismo instante pueden cambiar de página entre pedidos
        // y una fila se ve dos veces o ninguna.
        orderBy: [{ paidAt: 'desc' }, { id: 'desc' }],
        skip,
        take,
      }),
      this.prisma.scoped.appointmentPayment.count({ where }),
      this.rangeTotals(where),
    ]);

    return {
      data: rows.map(toRangeItem),
      meta: paginationMeta(total, { page, pageSize }),
      totals,
    };
  }

  /**
   * Lo que **falta** cobrar de un rango.
   *
   * **Es un reporte de turnos, no de pagos, y esa es toda la idea.** `GET
   * /payments` filtra por `paidAt`: un cobro pendiente no tiene fecha de
   * acreditación, así que no puede caer en ningún rango y la deuda del mes era
   * invisible salvo mirando turno por turno. Acá la fecha de una deuda es la
   * del **turno**, que es la única que existe.
   *
   * **El saldo sale de `appointmentBalance`, fila por fila.** No hay un `WHERE
   * due > 0` posible: `dueCents` no es una columna, es
   * `max(0, total - pagado)`. Empujarlo a SQL obligaría a escribir la regla de
   * qué pago suma y qué pago resta por segunda vez, que es exactamente el error
   * que este módulo evita. El precio es que el rango entero pasa por memoria
   * antes del recorte —de ahí el tope de días— y que el `total` del `meta`
   * cuenta turnos que deben, no turnos del rango.
   */
  async findReceivables(
    query: PaymentReceivablesQueryDto,
  ): Promise<PaymentReceivablesResponseDto> {
    // El regex del DTO valida la forma y deja pasar un 31 de febrero.
    parseDateOnly(query.from);
    parseDateOnly(query.to);

    if (query.from > query.to) {
      throw new BadRequestException(
        'El rango termina antes de empezar: revisá `from` y `to`',
      );
    }

    const timezone = await this.tenantTimezone();
    const start = zonedWallTimeToUtc(query.from, 0, timezone);
    const end = zonedWallTimeToUtc(query.to, MINUTES_PER_DAY, timezone);

    if (
      end.getTime() - start.getTime() >
      MAX_RECEIVABLES_RANGE_DAYS * MS_PER_DAY
    ) {
      throw new BadRequestException(
        `El rango no puede pasar de ${MAX_RECEIVABLES_RANGE_DAYS} días`,
      );
    }

    const [rows, currency] = await Promise.all([
      this.prisma.scoped.appointment.findMany({
        where: {
          // Días del calendario del negocio, igual que en `GET /payments`: un
          // turno de las 23:00 en Buenos Aires es de ese día y no del siguiente.
          startsAt: { gte: start, lt: end },
          status: { in: [...OWING_APPOINTMENT_STATUSES] },
          ...(query.branchId === undefined ? {} : { branchId: query.branchId }),
          ...(query.employeeId === undefined
            ? {}
            : { employeeId: query.employeeId }),
        },
        select: RECEIVABLE_SELECT,
        // El más viejo primero: lo que se debe hace más tiempo es lo que hay
        // que reclamar. El id desempata para que paginar sea estable.
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
      }),
      this.tenantCurrency(),
    ]);

    const owing = rows
      .map((row) => toReceivable(row, currency))
      .filter((item) => item.dueCents > 0);

    const { page, pageSize, skip, take } = resolvePagination(query);

    return {
      data: owing.slice(skip, skip + take),
      meta: paginationMeta(owing.length, { page, pageSize }),
      totals: receivablesTotals(owing),
    };
  }

  /**
   * El `where` del rango. **Los días son días del negocio, no de UTC.**
   *
   * Un cobro de las 21:30 en Buenos Aires es de ese día; armando el rango en
   * UTC caería en el siguiente y los totales del mes no cerrarían contra lo
   * que el mostrador vio pasar.
   */
  private async rangeFilter(
    query: PaymentRangeQueryDto,
  ): Promise<Prisma.AppointmentPaymentWhereInput> {
    // El regex del DTO valida la forma y deja pasar un 31 de febrero; eso solo
    // lo agarra el parseo, y sin esto saldría 500 en vez de 400.
    parseDateOnly(query.from);
    parseDateOnly(query.to);

    if (query.from > query.to) {
      throw new BadRequestException(
        'El rango termina antes de empezar: revisá `from` y `to`',
      );
    }

    const timezone = await this.tenantTimezone();

    return {
      // `gte`/`lt` sobre una columna nullable ya deja afuera los pendientes y
      // los fallados: `paid_at IS NULL` no satisface ninguna comparación. Es
      // también lo que permite que el índice parcial sirva.
      paidAt: {
        gte: zonedWallTimeToUtc(query.from, 0, timezone),
        lt: zonedWallTimeToUtc(query.to, MINUTES_PER_DAY, timezone),
      },
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.paymentMethod === undefined
        ? {}
        : { paymentMethod: query.paymentMethod }),
      ...(query.branchId === undefined && query.employeeId === undefined
        ? {}
        : {
            appointment: {
              ...(query.branchId === undefined
                ? {}
                : { branchId: query.branchId }),
              ...(query.employeeId === undefined
                ? {}
                : { employeeId: query.employeeId }),
            },
          }),
    };
  }

  /**
   * Los totales del rango entero, agrupados en la base.
   *
   * **La regla de qué suma y qué resta sigue siendo `paymentTotals`.** Cada
   * grupo entra como si fuera un pago solo por su suma, así que no aparece una
   * segunda definición de "cuánto entró" escrita a mano acá — que es el error
   * clásico de esta tabla.
   */
  private async rangeTotals(
    where: Prisma.AppointmentPaymentWhereInput,
  ): Promise<PaymentRangeTotalsDto> {
    const groups = await this.prisma.scoped.appointmentPayment.groupBy({
      by: ['status', 'paymentType'],
      where,
      _sum: { amountCents: true },
    });

    return paymentTotals(
      groups.map((group) => ({
        amountCents: group._sum.amountCents ?? 0,
        paymentType: group.paymentType,
        status: group.status,
      })),
    );
  }

  /** Los días del rango son días del calendario del negocio. */
  private async tenantTimezone(): Promise<string> {
    const tenantId = this.tenantContext.getTenantId();

    const tenant = tenantId
      ? await this.prisma.tenant.findUnique({
          where: { id: tenantId },
          select: { timezone: true },
        })
      : null;

    return tenant?.timezone ?? 'America/Argentina/Buenos_Aires';
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
