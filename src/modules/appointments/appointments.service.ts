import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AppointmentSource,
  AppointmentStatus,
  Prisma,
  RecurrenceFrequency,
  type CancellationRefundType,
} from '@prisma/client';
import { TenantContextMissingError } from '../../common/errors/tenant-context-missing.error';
import { TenantContextService } from '../../common/tenant-context';
import { parseDateOnly } from '../../common/utils/date-only.util';
import {
  MINUTES_PER_DAY,
  timeColumnToMinutes,
  zonedDateOnly,
  zonedDayOfWeek,
  zonedMinutesOfDay,
  zonedWallTimeToUtc,
} from '../../common/utils/timezone.util';
import { exclusionViolationConstraint } from '../../prisma/exclusion-violation';
import { scopedCreate } from '../../prisma/extensions';
import {
  PrismaService,
  type ScopedTransactionClient,
} from '../../prisma/prisma.service';
import {
  BLOCKING_STATUSES,
  intersectIntervals,
  mergeIntervals,
  splitIntoSlots,
  subtractIntervals,
  type Interval,
} from './availability';
import {
  allowedTransitions,
  canTransition,
  isCanceled,
  isTerminal,
  resolveRefund,
  type CancellationPolicy,
} from './status-machine';
import { recurrenceDates } from './recurrence';
import { MAX_RANGE_DAYS } from './dto/appointment.dto';
import type {
  AppointmentResponseDto,
  ChangeAppointmentStatusDto,
  ChangeStatusResultDto,
  CreateAppointmentDto,
  CreateRecurringAppointmentsDto,
  ListAppointmentsQueryDto,
  RecurringResultDto,
  RescheduleAppointmentDto,
  UpdateAppointmentDto,
} from './dto/appointment.dto';
import type {
  AvailabilityQueryDto,
  AvailabilityResponseDto,
  AvailabilitySlotDto,
  AvailableEmployeeDto,
} from './dto/availability.dto';

/** Todo lo que hace falta para responder un turno completo. */
const APPOINTMENT_SELECT = {
  id: true,
  startsAt: true,
  endsAt: true,
  status: true,
  createdVia: true,
  totalPriceCents: true,
  depositAmountCents: true,
  depositPaid: true,
  notes: true,
  canceledAt: true,
  cancellationReason: true,
  recurrenceGroupId: true,
  rescheduledFromId: true,
  employeeId: true,
  createdAt: true,
  updatedAt: true,
  branch: { select: { id: true, name: true } },
  employee: {
    select: {
      id: true,
      user: { select: { firstName: true, lastName: true } },
    },
  },
  customer: {
    select: { id: true, firstName: true, lastName: true, phone: true },
  },
  rescheduledTo: { select: { id: true } },
  services: {
    select: {
      serviceId: true,
      durationMinutes: true,
      priceCents: true,
      service: { select: { name: true } },
    },
    orderBy: { createdAt: 'asc' },
  },
  resources: {
    select: { resourceId: true, resource: { select: { name: true } } },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.AppointmentSelect;

type AppointmentRow = Prisma.AppointmentGetPayload<{
  select: typeof APPOINTMENT_SELECT;
}>;

/**
 * Lo que un turno necesita y que no cambia con la fecha. Una serie lo calcula
 * una vez y lo reusa para las N repeticiones.
 */
interface BookingPlan {
  branchId: string;
  employeeId: string;
  customerId: string;
  serviceIds: string[];
  services: ServiceSnapshot[];
  totals: { minutes: number; priceCents: number; depositCents: number | null };
  status: AppointmentStatus;
  resourceIds: string[];
  timezone: string;
}

/** El servicio tal como se lo copia al turno. */
interface ServiceSnapshot {
  id: string;
  name: string;
  durationMinutes: number;
  bufferAfterMinutes: number;
  priceCents: number;
  depositAmountCents: number | null;
}

/**
 * Lo mínimo que necesita `syncResourceMirror` de un cliente de Prisma.
 *
 * Se tipea estructuralmente para que funcione igual con el cliente normal y con
 * el de una transacción, sin tener que importar el tipo del cliente extendido
 * (que con las extensions no es el `Prisma.TransactionClient` de siempre).
 */
interface MirrorWriter {
  appointmentResource: {
    updateMany(args: {
      where: { appointmentId: string };
      data: { startsAt: Date; endsAt: Date; blocksSlot: boolean };
    }): Promise<unknown>;
    createMany(args: {
      data: Prisma.AppointmentResourceUncheckedCreateInput[];
    }): Promise<unknown>;
  };
}

/** Una ventana de atención en hora de pared, antes de volverse instantes. */
interface WallClockWindow {
  fromMinutes: number;
  toMinutes: number;
}

@Injectable()
export class AppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Los huecos en los que se puede reservar un servicio, un día dado.
   *
   * La cuenta es siempre la misma:
   *
   * ```
   * (horario de la sucursal ∩ horario del empleado)
   *   − ausencias − turnos que ya tiene − recursos ocupados
   * ```
   *
   * y después se corta en slots de `duración + buffer`. Cada resta está en una
   * función pura de `availability.ts`, que es donde viven los tests de los casos
   * borde; acá solo se junta lo que hace falta de la base.
   *
   * **Acepta varios servicios, igual que el alta.** El hueco tiene que medir
   * la suma de todos —corte y color en la misma visita es un caso normal— y
   * quien lo toma tiene que prestarlos **todos**: es una intersección de
   * profesionales, no una unión. Consultar con un servicio de un turno de
   * varios ofrecería horarios en los que el turno después no entra.
   *
   * **Todo se convierte a instantes antes de operar.** El horario de atención
   * es hora de pared ("de 9 a 18") y los turnos son `TIMESTAMPTZ`: mezclarlos
   * sin pasar por la zona del negocio da resultados que fallan justo el día que
   * cambia la hora.
   *
   * No se filtran los slots que ya pasaron. El endpoint describe lo que el
   * horario permite, no lo que todavía se puede reservar: para el mostrador un
   * hueco de hace una hora sigue siendo información válida (alguien llegó sin
   * turno), y el portal público (Fase 7) sí va a tener que recortarlos. Filtrar
   * acá se lo sacaría a los dos.
   */
  async findAvailability(
    query: AvailabilityQueryDto,
  ): Promise<AvailabilityResponseDto> {
    const timezone = await this.tenantTimezone();

    // La misma validación que el alta, y a propósito: que existan, que sean de
    // este negocio, que estén activos y que no vengan repetidos. Ofrecer
    // huecos para un servicio que `POST /appointments` después rechaza sería
    // peor que rechazarlo acá.
    const services = await this.loadServices(query.serviceIds);
    await this.assertBranchExists(query.branchId);

    // **La duración sale de la misma regla que el alta** (`totalsOf`). Si las
    // dos no coincidieran, el hueco que se ofrece no sería el que después
    // entra, y el usuario elegiría un horario para comerse un 409.
    const slotMinutes = totalsOf(services).minutes;
    const durationMinutes = services.reduce(
      (total, service) => total + service.durationMinutes,
      0,
    );

    const dayStart = zonedWallTimeToUtc(query.date, 0, timezone);
    const dayEnd = zonedWallTimeToUtc(query.date, MINUTES_PER_DAY, timezone);

    const base: Omit<
      AvailabilityResponseDto,
      'branchClosed' | 'noEmployeeForServices' | 'slots'
    > = {
      date: query.date,
      timezone,
      durationMinutes,
      // Restado y no sumado aparte: así `durationMinutes + bufferAfterMinutes`
      // sigue siendo el largo del hueco por construcción, aunque `totalsOf`
      // cambie de cuenta algún día.
      bufferAfterMinutes: slotMinutes - durationMinutes,
    };

    // Los dos motivos de "sin lugar" se resuelven juntos y no en cascada,
    // porque para quien mira son distintos: un día cerrado se arregla
    // cambiando de fecha, que nadie preste la combinación no. Contestar solo
    // el primero escondería el segundo.
    const [branchWindow, employees] = await Promise.all([
      this.branchWindow(query.branchId, query.date, timezone),
      this.employeesForServices(query),
    ]);

    const noEmployeeForServices = employees.length === 0;

    if (!branchWindow || noEmployeeForServices) {
      return {
        ...base,
        branchClosed: !branchWindow,
        noEmployeeForServices,
        slots: [],
      };
    }

    const branchOpen = [toInterval(branchWindow, query.date, timezone)];
    const employeeIds = employees.map((employee) => employee.employeeId);

    const [schedules, timeOff, appointments, resourceBusy] = await Promise.all([
      this.schedulesByEmployee(
        employeeIds,
        query.branchId,
        query.date,
        timezone,
      ),
      this.timeOffByEmployee(employeeIds, query.branchId, dayStart, dayEnd),
      this.appointmentsByEmployee(employeeIds, dayStart, dayEnd),
      // Con varios servicios pueden hacer falta más de un recurso: la camilla
      // de uno y la lámpara del otro. `resourceBusyIntervals` ya recibía una
      // lista; lo único que pasaba es que la disponibilidad le mandaba uno.
      this.resourceBusyIntervals(
        query.serviceIds,
        query.branchId,
        dayStart,
        dayEnd,
      ),
    ]);

    /** startsAt en ISO → quiénes lo tienen libre. Agrupa a los que coinciden. */
    const byStart = new Map<string, AvailabilitySlotDto>();

    for (const employee of employees) {
      const working = intersectIntervals(
        branchOpen,
        schedules.get(employee.employeeId) ?? [],
      );

      const free = subtractIntervals(working, [
        ...(timeOff.get(employee.employeeId) ?? []),
        ...(appointments.get(employee.employeeId) ?? []),
        ...resourceBusy,
      ]);

      for (const slot of splitIntoSlots(free, slotMinutes)) {
        const key = slot.start.toISOString();
        const existing = byStart.get(key);

        if (existing) {
          existing.employees.push(employee);
          continue;
        }

        byStart.set(key, {
          startsAt: slot.start,
          endsAt: slot.end,
          employees: [employee],
        });
      }
    }

    const slots = [...byStart.values()].sort(
      (a, b) => a.startsAt.getTime() - b.startsAt.getTime(),
    );

    return {
      ...base,
      branchClosed: false,
      noEmployeeForServices: false,
      slots,
    };
  }

  /**
   * Agenda un turno.
   *
   * El orden importa: primero se valida todo lo que se puede saber leyendo
   * (que el profesional preste ese servicio ahí, que el hueco esté libre) y
   * recién después se escribe. Pero **la validación previa no es la que
   * garantiza que no haya doble-booking**: dos requests simultáneas al mismo
   * slot la pasan las dos, porque en el momento de mirar todavía no hay nada
   * que las moleste. Lo que desempata es el EXCLUDE constraint de Postgres, y
   * por eso el `catch` de abajo no es un detalle: es el mecanismo.
   *
   * (Correr la validación adentro de la transacción tampoco cambiaría eso:
   * en READ COMMITTED cada consulta ve su propio snapshot. Se hace afuera, que
   * es más simple y no promete una protección que no da.)
   */
  async create(
    dto: CreateAppointmentDto,
    createdByUserId: string,
  ): Promise<AppointmentResponseDto> {
    const timezone = await this.tenantTimezone();
    const services = await this.loadServices(dto.serviceIds);
    const totals = totalsOf(services);

    const startsAt = new Date(dto.startsAt);
    const endsAt = addMinutes(startsAt, totals.minutes);

    await this.assertEmployeeCanPerform(
      dto.employeeId,
      dto.branchId,
      dto.serviceIds,
    );
    await this.assertCustomerExists(dto.customerId);
    await this.assertSlotIsFree({
      employeeId: dto.employeeId,
      branchId: dto.branchId,
      serviceIds: dto.serviceIds,
      startsAt,
      endsAt,
      timezone,
    });

    const plan = await this.bookingPlan(dto, services, totals);
    const id = await this.insertAppointment(plan, startsAt, endsAt, {
      createdByUserId,
      createdVia: AppointmentSource.ADMIN,
      notes: dto.notes ?? null,
    });

    return this.findOne(id);
  }

  /**
   * Agenda una serie de turnos repetidos.
   *
   * **Los que chocan se saltean, no tumban la serie.** Si el turno 7 de 10 cae
   * en un feriado o en un hueco ya tomado, se crean los otros 9 y el que quedó
   * afuera vuelve en `skipped` con el motivo. Rechazar los diez porque uno no
   * entra obligaría al mostrador a adivinar cuál era y rehacer todo a mano.
   *
   * Consecuencia de esa decisión: **cada turno va en su propia transacción**.
   * Una transacción única no serviría — en Postgres el primer error la aborta
   * entera, que es justo lo contrario de "seguí con los demás".
   *
   * Si no entró ninguno la respuesta es un 409 con la lista de motivos: la
   * serie no existiría y devolver un grupo vacío sería basura en la base.
   */
  async createRecurring(
    dto: CreateRecurringAppointmentsDto,
    createdByUserId: string,
  ): Promise<RecurringResultDto> {
    const timezone = await this.tenantTimezone();
    const services = await this.loadServices(dto.serviceIds);
    const totals = totalsOf(services);
    const plan = await this.bookingPlan(dto, services, totals);

    // La hora se guarda aparte de la fecha: la serie repite una hora de pared
    // ("los lunes a las 10"), no un intervalo fijo de milisegundos.
    const first = new Date(dto.startsAt);
    const minutesOfDay = zonedMinutesOfDay(first, timezone);
    const dates = recurrenceDates(
      zonedDateOnly(first, timezone),
      dto.frequency,
      dto.occurrences,
    );

    const group = await this.prisma.scoped.recurrenceGroup.create({
      data: scopedCreate<Prisma.RecurrenceGroupUncheckedCreateInput>({
        frequency: dto.frequency,
        dayOfWeek:
          dto.frequency === RecurrenceFrequency.MONTHLY
            ? null
            : zonedDayOfWeek(dates[0], timezone),
        occurrences: dto.occurrences,
      }),
      select: { id: true },
    });

    const created: string[] = [];
    const skipped: { startsAt: Date; reason: string }[] = [];

    for (const date of dates) {
      const startsAt = zonedWallTimeToUtc(date, minutesOfDay, timezone);
      const endsAt = addMinutes(startsAt, totals.minutes);

      try {
        created.push(
          await this.insertAppointment(plan, startsAt, endsAt, {
            createdByUserId,
            createdVia: AppointmentSource.RECURRING,
            notes: dto.notes ?? null,
            recurrenceGroupId: group.id,
          }),
        );
      } catch (error) {
        if (!(error instanceof ConflictException)) {
          throw error;
        }

        skipped.push({ startsAt, reason: conflictMessage(error) });
      }
    }

    if (created.length === 0) {
      await this.prisma.scoped.recurrenceGroup.delete({
        where: { id: group.id },
      });

      throw new ConflictException({
        message: 'Ninguna de las fechas de la serie estaba libre',
        skipped,
      });
    }

    // `occurrences` cuenta los turnos que existen, no los que se pidieron.
    await this.prisma.scoped.recurrenceGroup.update({
      where: { id: group.id },
      data: { occurrences: created.length },
    });

    return {
      recurrenceGroupId: group.id,
      created: await Promise.all(created.map((id) => this.findOne(id))),
      skipped,
    };
  }

  /**
   * Todo lo que un turno necesita saber y que **no depende de la fecha**: qué
   * servicios, cuánto sale, con qué estado nace y qué recursos ocupa.
   *
   * Existe para que una serie lo calcule una sola vez en vez de repetir las
   * mismas cinco consultas por cada turno.
   */
  private async bookingPlan(
    dto: CreateAppointmentDto,
    services: ServiceSnapshot[],
    totals: ReturnType<typeof totalsOf>,
  ): Promise<BookingPlan> {
    await this.assertEmployeeCanPerform(
      dto.employeeId,
      dto.branchId,
      dto.serviceIds,
    );
    await this.assertCustomerExists(dto.customerId);

    return {
      branchId: dto.branchId,
      employeeId: dto.employeeId,
      customerId: dto.customerId,
      serviceIds: dto.serviceIds,
      services,
      totals,
      status: await this.initialStatus(totals.depositCents),
      resourceIds: await this.requiredResourceIds(dto.serviceIds, dto.branchId),
      timezone: await this.tenantTimezone(),
    };
  }

  /** Valida el hueco y escribe el turno con sus servicios y recursos. */
  private async insertAppointment(
    plan: BookingPlan,
    startsAt: Date,
    endsAt: Date,
    meta: {
      createdByUserId: string;
      createdVia: AppointmentSource;
      notes: string | null;
      recurrenceGroupId?: string;
    },
  ): Promise<string> {
    await this.assertSlotIsFree({
      employeeId: plan.employeeId,
      branchId: plan.branchId,
      serviceIds: plan.serviceIds,
      startsAt,
      endsAt,
      timezone: plan.timezone,
    });

    try {
      return await this.prisma.scoped.$transaction(async (tx) => {
        const appointment = await tx.appointment.create({
          data: scopedCreate<Prisma.AppointmentUncheckedCreateInput>({
            branchId: plan.branchId,
            employeeId: plan.employeeId,
            customerId: plan.customerId,
            startsAt,
            endsAt,
            status: plan.status,
            totalPriceCents: plan.totals.priceCents,
            depositAmountCents: plan.totals.depositCents,
            notes: meta.notes,
            createdByUserId: meta.createdByUserId,
            createdVia: meta.createdVia,
            recurrenceGroupId: meta.recurrenceGroupId ?? null,
          }),
          select: { id: true },
        });

        await tx.appointmentService.createMany({
          data: plan.services.map((service) =>
            scopedCreate<Prisma.AppointmentServiceUncheckedCreateInput>({
              appointmentId: appointment.id,
              serviceId: service.id,
              durationMinutes: service.durationMinutes,
              priceCents: service.priceCents,
            }),
          ),
        });

        await this.createResourceRows(tx, appointment.id, plan.resourceIds, {
          startsAt,
          endsAt,
        });

        return appointment.id;
      });
    } catch (error) {
      throw scheduleConflictOr(error);
    }
  }

  /**
   * La agenda de un rango de fechas. Es un rango y no páginas porque quien lo
   * consume es un calendario: se pide "esta semana", no "página 3".
   */
  async findAll(
    query: ListAppointmentsQueryDto,
  ): Promise<AppointmentResponseDto[]> {
    const timezone = await this.tenantTimezone();
    const days = daysBetween(query.from, query.to);

    if (days < 0) {
      throw new BadRequestException('`from` no puede ser posterior a `to`');
    }

    if (days > MAX_RANGE_DAYS) {
      throw new BadRequestException(
        `El rango no puede pasar de ${MAX_RANGE_DAYS} días`,
      );
    }

    const rows = await this.prisma.scoped.appointment.findMany({
      where: {
        ...pickDefined({
          branchId: query.branchId,
          employeeId: query.employeeId,
          customerId: query.customerId,
        }),
        ...(query.status === undefined ? {} : { status: { in: query.status } }),
        ...overlapping(
          zonedWallTimeToUtc(query.from, 0, timezone),
          zonedWallTimeToUtc(query.to, MINUTES_PER_DAY, timezone),
        ),
      },
      select: APPOINTMENT_SELECT,
      orderBy: [{ startsAt: 'asc' }],
    });

    return rows.map(toAppointmentResponse);
  }

  async findOne(id: string): Promise<AppointmentResponseDto> {
    return toAppointmentResponse(await this.findAppointmentOrFail(id));
  }

  /** Lo único editable sin mover nada: las notas. */
  async update(
    id: string,
    dto: UpdateAppointmentDto,
  ): Promise<AppointmentResponseDto> {
    const current = await this.findAppointmentOrFail(id);

    if (dto.notes === undefined) {
      return toAppointmentResponse(current);
    }

    const updated = await this.prisma.scoped.appointment.update({
      where: { id, deletedAt: null },
      data: { notes: dto.notes },
      select: APPOINTMENT_SELECT,
    });

    return toAppointmentResponse(updated);
  }

  /**
   * Mueve el turno por la máquina de estados.
   *
   * Cancelar hace tres cosas además de cambiar el estado: sella `canceledAt`
   * (hay un CHECK en la base que exige que vayan juntos), libera los recursos
   * que tenía tomados y calcula qué devolución corresponde.
   */
  async changeStatus(
    id: string,
    dto: ChangeAppointmentStatusDto,
  ): Promise<ChangeStatusResultDto> {
    const current = await this.findAppointmentOrFail(id);

    if (!canTransition(current.status, dto.status)) {
      const posibles = allowedTransitions(current.status);

      throw new ConflictException(
        `Un turno en ${current.status} no puede pasar a ${dto.status}. ` +
          (posibles.length === 0
            ? 'Ese estado es final.'
            : `Solo puede pasar a: ${posibles.join(', ')}.`),
      );
    }

    const canceling = isCanceled(dto.status);
    const canceledAt = canceling ? new Date() : null;

    const refund = canceling
      ? resolveRefund(await this.cancellationPolicy(), current, canceledAt!)
      : null;

    const updated = await this.prisma.scoped.$transaction(async (tx) => {
      const appointment = await tx.appointment.update({
        where: { id, deletedAt: null },
        data: {
          status: dto.status,
          canceledAt,
          cancellationReason: canceling
            ? (dto.cancellationReason ?? null)
            : null,
        },
        select: APPOINTMENT_SELECT,
      });

      await this.syncResourceMirror(tx, appointment);

      return appointment;
    });

    return { appointment: toAppointmentResponse(updated), refund };
  }

  /**
   * Refleja en el turno el saldo que quedó después de mover plata.
   *
   * Lo llama `PaymentsService` cada vez que un pago cambia de estado, sea por
   * el webhook o por una carga manual. Vive acá y no allá porque **el estado de
   * un turno lo escribe el service de turnos**: si la lógica de confirmar se
   * duplicara del lado de pagos, el espejo de recursos y la máquina de estados
   * quedarían fuera de su único dueño.
   *
   * **El estado solo avanza.** Una seña cubierta confirma un turno que estaba
   * esperando el pago; una devolución **no lo des-confirma**. Volver atrás no
   * es una transición válida de la máquina de estados, y hacerlo en silencio
   * sería peor que el problema: el turno sigue en la agenda de alguien, y qué
   * hacer con eso lo decide el negocio (cancelándolo), no un webhook.
   *
   * `depositPaid` sí sigue al saldo en los dos sentidos: es un dato, no un
   * estado, y de ahí sale el cálculo de la devolución al cancelar.
   */
  async syncPaymentState(
    tx: ScopedTransactionClient,
    appointmentId: string,
    depositCovered: boolean,
  ): Promise<void> {
    const current = await tx.appointment.findFirst({
      where: { id: appointmentId },
      select: { id: true, status: true, depositPaid: true },
    });

    if (!current) {
      return;
    }

    const confirms =
      depositCovered && current.status === AppointmentStatus.PENDING_PAYMENT;

    if (!confirms && current.depositPaid === depositCovered) {
      return;
    }

    const appointment = await tx.appointment.update({
      where: { id: appointmentId },
      data: {
        depositPaid: depositCovered,
        ...(confirms ? { status: AppointmentStatus.CONFIRMED } : {}),
      },
      select: { id: true, startsAt: true, endsAt: true, status: true },
    });

    // `PENDING_PAYMENT` y `CONFIRMED` bloquean los dos, así que hoy esto no
    // cambia nada. Se llama igual porque la regla es que todo cambio de estado
    // pase por acá: el día que un turno impago deje de ocupar el lugar, esto ya
    // está bien y no hay que acordarse.
    await this.syncResourceMirror(tx, appointment);
  }

  /**
   * Mueve un turno de horario creando uno nuevo.
   *
   * No se edita el original a propósito: el turno viejo queda en
   * `rescheduled`, apuntado por el nuevo, y así el historial dice qué pasó.
   * Editar el horario en su lugar borraría el rastro de que hubo un cambio.
   *
   * **Los servicios se copian con el precio y la duración que tenían.** Si el
   * negocio subió el precio en el medio, el turno reprogramado sigue valiendo
   * lo que valía cuando se reservó: la clienta ya lo había acordado.
   */
  async reschedule(
    id: string,
    dto: RescheduleAppointmentDto,
    createdByUserId: string,
  ): Promise<AppointmentResponseDto> {
    const current = await this.findAppointmentOrFail(id);

    if (isTerminal(current.status)) {
      throw new ConflictException(
        `Un turno en ${current.status} ya está cerrado: no se puede reprogramar`,
      );
    }

    const timezone = await this.tenantTimezone();
    const employeeId = dto.employeeId ?? current.employeeId;
    const serviceIds = current.services.map((row) => row.serviceId);
    const minutes = current.services.reduce(
      (total, row) => total + row.durationMinutes,
      0,
    );

    const startsAt = new Date(dto.startsAt);
    const endsAt = addMinutes(startsAt, minutes);

    if (dto.employeeId !== undefined) {
      await this.assertEmployeeCanPerform(
        employeeId,
        current.branch.id,
        serviceIds,
      );
    }

    // El turno viejo no se cuenta como ocupado: es justo el que se está moviendo.
    await this.assertSlotIsFree({
      employeeId,
      branchId: current.branch.id,
      serviceIds,
      startsAt,
      endsAt,
      timezone,
      excludeAppointmentId: id,
    });

    const resourceIds = await this.requiredResourceIds(
      serviceIds,
      current.branch.id,
    );

    try {
      const nuevoId = await this.prisma.scoped.$transaction(async (tx) => {
        const viejo = await tx.appointment.update({
          where: { id, deletedAt: null },
          data: {
            status: AppointmentStatus.RESCHEDULED,
            cancellationReason: dto.reason ?? null,
          },
          select: { id: true, startsAt: true, endsAt: true, status: true },
        });

        await this.syncResourceMirror(tx, viejo);

        const nuevo = await tx.appointment.create({
          data: scopedCreate<Prisma.AppointmentUncheckedCreateInput>({
            branchId: current.branch.id,
            employeeId,
            customerId: current.customer.id,
            startsAt,
            endsAt,
            status: current.status,
            totalPriceCents: current.totalPriceCents,
            depositAmountCents: current.depositAmountCents,
            depositPaid: current.depositPaid,
            notes: current.notes,
            createdByUserId,
            createdVia: current.createdVia,
            recurrenceGroupId: current.recurrenceGroupId,
            rescheduledFromId: id,
          }),
          select: { id: true },
        });

        await tx.appointmentService.createMany({
          data: current.services.map((row) =>
            scopedCreate<Prisma.AppointmentServiceUncheckedCreateInput>({
              appointmentId: nuevo.id,
              serviceId: row.serviceId,
              durationMinutes: row.durationMinutes,
              priceCents: row.priceCents,
            }),
          ),
        });

        await this.createResourceRows(tx, nuevo.id, resourceIds, {
          startsAt,
          endsAt,
        });

        return nuevo.id;
      });

      return await this.findOne(nuevoId);
    } catch (error) {
      throw scheduleConflictOr(error);
    }
  }

  /**
   * Que el hueco pedido entre en el tiempo libre del profesional.
   *
   * Se pide **contención**, no que coincida con un slot de la grilla: el
   * mostrador tiene que poder agendar a las 09:07 para alguien que llegó sin
   * turno. La grilla de `GET /availability` es una sugerencia para elegir, no
   * una restricción.
   */
  private async assertSlotIsFree(params: {
    employeeId: string;
    branchId: string;
    serviceIds: string[];
    startsAt: Date;
    endsAt: Date;
    timezone: string;
    excludeAppointmentId?: string;
  }): Promise<void> {
    const date = zonedDateOnly(params.startsAt, params.timezone);
    const free = await this.freeIntervalsFor({ ...params, date });

    const entra = free.some(
      (hueco) =>
        hueco.start.getTime() <= params.startsAt.getTime() &&
        params.endsAt.getTime() <= hueco.end.getTime(),
    );

    if (entra) {
      return;
    }

    throw new ConflictException(
      free.length === 0
        ? 'Ese profesional no atiende ese día en esa sucursal'
        : 'Ese horario no está libre: se pisa con otro turno, con una ausencia, ' +
            'con un recurso ocupado, o queda fuera del horario de atención',
    );
  }

  /** El tiempo libre de UN profesional un día, con la misma cuenta de siempre. */
  private async freeIntervalsFor(params: {
    employeeId: string;
    branchId: string;
    serviceIds: string[];
    date: string;
    timezone: string;
    excludeAppointmentId?: string;
  }): Promise<Interval[]> {
    const branchWindow = await this.branchWindow(
      params.branchId,
      params.date,
      params.timezone,
    );

    if (!branchWindow) {
      return [];
    }

    const dayStart = zonedWallTimeToUtc(params.date, 0, params.timezone);
    const dayEnd = zonedWallTimeToUtc(
      params.date,
      MINUTES_PER_DAY,
      params.timezone,
    );
    const soloEl = [params.employeeId];

    const [schedules, timeOff, appointments, resourceBusy] = await Promise.all([
      this.schedulesByEmployee(
        soloEl,
        params.branchId,
        params.date,
        params.timezone,
      ),
      this.timeOffByEmployee(soloEl, params.branchId, dayStart, dayEnd),
      this.appointmentsByEmployee(
        soloEl,
        dayStart,
        dayEnd,
        params.excludeAppointmentId,
      ),
      this.resourceBusyIntervals(
        params.serviceIds,
        params.branchId,
        dayStart,
        dayEnd,
        params.excludeAppointmentId,
      ),
    ]);

    const working = intersectIntervals(
      [toInterval(branchWindow, params.date, params.timezone)],
      schedules.get(params.employeeId) ?? [],
    );

    return subtractIntervals(working, [
      ...(timeOff.get(params.employeeId) ?? []),
      ...(appointments.get(params.employeeId) ?? []),
      ...resourceBusy,
    ]);
  }

  /**
   * Los servicios del turno, validados: que existan, que sean de este negocio y
   * que estén activos.
   */
  private async loadServices(serviceIds: string[]): Promise<ServiceSnapshot[]> {
    if (new Set(serviceIds).size !== serviceIds.length) {
      throw new BadRequestException('Hay servicios repetidos en el turno');
    }

    const services = await this.prisma.scoped.service.findMany({
      where: { id: { in: serviceIds } },
      select: {
        id: true,
        name: true,
        durationMinutes: true,
        bufferAfterMinutes: true,
        priceCents: true,
        depositAmountCents: true,
        isActive: true,
      },
    });

    const encontrados = new Set(services.map((service) => service.id));
    const faltan = serviceIds.filter((id) => !encontrados.has(id));

    if (faltan.length > 0) {
      throw new BadRequestException(
        `Estos servicios no existen en tu negocio: ${faltan.join(', ')}`,
      );
    }

    const inactivos = services.filter((service) => !service.isActive);

    if (inactivos.length > 0) {
      throw new BadRequestException(
        'Estos servicios están desactivados y no se pueden reservar: ' +
          inactivos.map((service) => service.name).join(', '),
      );
    }

    // El orden del pedido manda: los servicios se hacen en ese orden.
    return serviceIds.map(
      (id) => services.find((service) => service.id === id)!,
    );
  }

  /**
   * Que el profesional preste **cada** servicio **en esa sucursal**. Es la regla
   * que la Fase 3 dejó escrita en `employee_services`: sin esto se podrían
   * agendar turnos que nadie puede atender.
   */
  private async assertEmployeeCanPerform(
    employeeId: string,
    branchId: string,
    serviceIds: string[],
  ): Promise<void> {
    const asignados = await this.prisma.scoped.employeeService.findMany({
      where: { employeeId, branchId, serviceId: { in: serviceIds } },
      select: { serviceId: true },
    });

    const puede = new Set(asignados.map((row) => row.serviceId));
    const noPuede = serviceIds.filter((id) => !puede.has(id));

    if (noPuede.length > 0) {
      throw new BadRequestException(
        'Ese profesional no presta estos servicios en esa sucursal: ' +
          noPuede.join(', '),
      );
    }
  }

  private async assertCustomerExists(customerId: string): Promise<void> {
    const customer = await this.prisma.scoped.customer.findFirst({
      where: { id: customerId },
      select: { id: true },
    });

    if (!customer) {
      throw new BadRequestException('El cliente no existe en tu negocio');
    }
  }

  /**
   * Los recursos que el turno va a ocupar: los que requieren sus servicios y
   * están en esa sucursal. Mismo criterio que la disponibilidad.
   */
  private async requiredResourceIds(
    serviceIds: string[],
    branchId: string,
  ): Promise<string[]> {
    const required = await this.prisma.scoped.serviceResource.findMany({
      where: {
        serviceId: { in: serviceIds },
        resource: { branchId, isActive: true, deletedAt: null },
      },
      select: { resourceId: true },
    });

    return [...new Set(required.map((row) => row.resourceId))];
  }

  /**
   * Con qué estado nace el turno.
   *
   * `requireDepositForBooking` es lo que decide: con la bandera prendida el
   * turno queda esperando el pago de la seña; apagada, se confirma de una y la
   * seña (si la hay) se cobra cuando se cobra. Sin monto que cobrar no hay nada
   * que esperar, así que ahí siempre se confirma.
   */
  private async initialStatus(
    depositCents: number | null,
  ): Promise<AppointmentStatus> {
    if (depositCents === null || depositCents <= 0) {
      return AppointmentStatus.CONFIRMED;
    }

    const settings = await this.tenantSettings();

    return settings.requireDepositForBooking
      ? AppointmentStatus.PENDING_PAYMENT
      : AppointmentStatus.CONFIRMED;
  }

  private async cancellationPolicy(): Promise<CancellationPolicy> {
    const settings = await this.tenantSettings();

    return {
      cancellationPolicyHours: settings.cancellationPolicyHours,
      cancellationRefundType: settings.cancellationRefundType,
      cancellationRefundPercentage: settings.cancellationRefundPercentage,
    };
  }

  private async tenantSettings(): Promise<{
    requireDepositForBooking: boolean;
    cancellationPolicyHours: number;
    cancellationRefundType: CancellationRefundType;
    cancellationRefundPercentage: number | null;
  }> {
    const tenantId = this.tenantContext.getTenantId();

    if (!tenantId) {
      throw new TenantContextMissingError('Tenant', 'read settings');
    }

    const settings = await this.prisma.scoped.tenantSettings.findFirst({
      where: { tenantId },
      select: {
        requireDepositForBooking: true,
        cancellationPolicyHours: true,
        cancellationRefundType: true,
        cancellationRefundPercentage: true,
      },
    });

    if (!settings) {
      throw new NotFoundException('El negocio no tiene configuración cargada');
    }

    return settings;
  }

  private async createResourceRows(
    tx: MirrorWriter,
    appointmentId: string,
    resourceIds: string[],
    window: { startsAt: Date; endsAt: Date },
  ): Promise<void> {
    if (resourceIds.length === 0) {
      return;
    }

    await tx.appointmentResource.createMany({
      data: resourceIds.map((resourceId) =>
        scopedCreate<Prisma.AppointmentResourceUncheckedCreateInput>({
          appointmentId,
          resourceId,
          startsAt: window.startsAt,
          endsAt: window.endsAt,
        }),
      ),
    });
  }

  /**
   * **El único lugar que escribe la copia de `appointment_resources`.**
   *
   * Esas tres columnas (`starts_at`, `ends_at`, `blocks_slot`) son un espejo de
   * las del turno, y existen solo porque un EXCLUDE constraint no puede leer
   * otra tabla. Si se desincronizan, la base deja pasar un doble-booking de
   * recursos sin decir nada — por eso toda escritura pasa por acá y no se
   * repite el `updateMany` en cada método.
   */
  private async syncResourceMirror(
    tx: MirrorWriter,
    appointment: {
      id: string;
      startsAt: Date;
      endsAt: Date;
      status: AppointmentStatus;
    },
  ): Promise<void> {
    await tx.appointmentResource.updateMany({
      where: { appointmentId: appointment.id },
      data: {
        startsAt: appointment.startsAt,
        endsAt: appointment.endsAt,
        blocksSlot: BLOCKING_STATUSES.includes(appointment.status),
      },
    });
  }

  private async findAppointmentOrFail(id: string): Promise<AppointmentRow> {
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
   * El horario de la sucursal ese día, en hora de pared.
   *
   * Un `BranchSpecialDay` pisa al horario semanal: puede cerrar el local
   * (feriado, el caso común) o darle un horario distinto. `null` = cerrado.
   */
  private async branchWindow(
    branchId: string,
    date: string,
    timezone: string,
  ): Promise<WallClockWindow | null> {
    const specialDay = await this.prisma.scoped.branchSpecialDay.findFirst({
      where: { branchId, date: parseDateOnly(date) },
      select: { isClosed: true, opensAt: true, closesAt: true },
    });

    const source =
      specialDay ??
      (await this.prisma.scoped.branchBusinessHour.findFirst({
        where: { branchId, dayOfWeek: zonedDayOfWeek(date, timezone) },
        select: { isClosed: true, opensAt: true, closesAt: true },
      }));

    if (!source || source.isClosed || !source.opensAt || !source.closesAt) {
      return null;
    }

    return {
      fromMinutes: timeColumnToMinutes(source.opensAt),
      toMinutes: timeColumnToMinutes(source.closesAt),
    };
  }

  /**
   * Quiénes prestan ese servicio en esa sucursal. Sale de `employee_services`,
   * que la Fase 3 ya valida contra las sucursales donde cada uno trabaja.
   *
   * Los desactivados quedan afuera: siguen existiendo pero no atienden.
   */
  /**
   * Quiénes pueden tomar el turno entero: los que prestan **todos** los
   * servicios pedidos en esa sucursal.
   *
   * **Es una intersección, no una unión**, porque un turno lo atiende una sola
   * persona. Si Lucía hace corte y Ana hace color pero ninguna las dos, la
   * respuesta correcta es que nadie puede — devolver a las dos ofrecería
   * horarios que después el alta rechaza.
   */
  private async employeesForServices(
    query: AvailabilityQueryDto,
  ): Promise<AvailableEmployeeDto[]> {
    const assignments = await this.prisma.scoped.employeeService.findMany({
      where: {
        serviceId: { in: query.serviceIds },
        branchId: query.branchId,
        ...(query.employeeId === undefined
          ? {}
          : { employeeId: query.employeeId }),
        employee: { isActive: true, deletedAt: null },
      },
      select: {
        employeeId: true,
        serviceId: true,
        employee: {
          select: { user: { select: { firstName: true, lastName: true } } },
        },
      },
    });

    const required = new Set(query.serviceIds).size;

    const byEmployee = new Map<
      string,
      { employeeName: string; services: Set<string> }
    >();

    for (const assignment of assignments) {
      const entry = byEmployee.get(assignment.employeeId) ?? {
        employeeName: `${assignment.employee.user.firstName} ${assignment.employee.user.lastName}`,
        services: new Set<string>(),
      };

      entry.services.add(assignment.serviceId);
      byEmployee.set(assignment.employeeId, entry);
    }

    return [...byEmployee.entries()]
      .filter(([, entry]) => entry.services.size === required)
      .map(([employeeId, entry]) => ({
        employeeId,
        employeeName: entry.employeeName,
      }));
  }

  /**
   * El horario de cada empleado ese día de la semana, ya como instantes. Puede
   * haber varias filas por día: es un turno partido.
   */
  private async schedulesByEmployee(
    employeeIds: string[],
    branchId: string,
    date: string,
    timezone: string,
  ): Promise<Map<string, Interval[]>> {
    const schedules = await this.prisma.scoped.employeeSchedule.findMany({
      where: {
        employeeId: { in: employeeIds },
        branchId,
        dayOfWeek: zonedDayOfWeek(date, timezone),
      },
      select: { employeeId: true, startsAt: true, endsAt: true },
    });

    return groupBy(
      schedules,
      (row) => row.employeeId,
      (row) =>
        toInterval(
          {
            fromMinutes: timeColumnToMinutes(row.startsAt),
            toMinutes: timeColumnToMinutes(row.endsAt),
          },
          date,
          timezone,
        ),
    );
  }

  /**
   * Ausencias que pisan el día. `branchId` en null significa "en todas": el que
   * está de vacaciones no atiende en ninguna sucursal.
   */
  private async timeOffByEmployee(
    employeeIds: string[],
    branchId: string,
    dayStart: Date,
    dayEnd: Date,
  ): Promise<Map<string, Interval[]>> {
    const absences = await this.prisma.scoped.employeeTimeOff.findMany({
      where: {
        employeeId: { in: employeeIds },
        OR: [{ branchId: null }, { branchId }],
        ...overlapping(dayStart, dayEnd),
      },
      select: { employeeId: true, startsAt: true, endsAt: true },
    });

    return groupBy(absences, (row) => row.employeeId, toRowInterval);
  }

  /**
   * Los turnos que ya tiene cada uno. Se piden **sin filtrar por sucursal**: si
   * alguien está atendiendo en Palermo, no puede estar también en Centro.
   */
  private async appointmentsByEmployee(
    employeeIds: string[],
    dayStart: Date,
    dayEnd: Date,
    excludeAppointmentId?: string,
  ): Promise<Map<string, Interval[]>> {
    const appointments = await this.prisma.scoped.appointment.findMany({
      where: {
        employeeId: { in: employeeIds },
        status: { in: [...BLOCKING_STATUSES] },
        ...(excludeAppointmentId === undefined
          ? {}
          : { id: { not: excludeAppointmentId } }),
        ...overlapping(dayStart, dayEnd),
      },
      select: { employeeId: true, startsAt: true, endsAt: true },
    });

    return groupBy(appointments, (row) => row.employeeId, toRowInterval);
  }

  /**
   * Cuándo está ocupado algún recurso que el servicio necesita.
   *
   * Dos decisiones que conviene tener presentes:
   *
   * - **Solo cuentan los recursos que están en la sucursal consultada.** Un
   *   servicio puede requerir la sala de Centro y la de Palermo; en Centro solo
   *   manda la de Centro. Es la intersección que la Fase 3 dejó explícitamente
   *   para acá.
   * - **Si el servicio requiere varios recursos de esa sucursal, los necesita a
   *   todos a la vez**, así que basta con que uno esté ocupado para que el hueco
   *   no sirva. Por eso se unen todos los rangos en una sola lista.
   *
   * Si el servicio no requiere ningún recurso *de esa sucursal*, no impone
   * restricción: la lista vuelve vacía.
   */
  private async resourceBusyIntervals(
    serviceIds: string[],
    branchId: string,
    dayStart: Date,
    dayEnd: Date,
    excludeAppointmentId?: string,
  ): Promise<Interval[]> {
    const required = await this.prisma.scoped.serviceResource.findMany({
      where: {
        serviceId: { in: serviceIds },
        resource: { branchId, isActive: true, deletedAt: null },
      },
      select: { resourceId: true },
    });

    if (required.length === 0) {
      return [];
    }

    const busy = await this.prisma.scoped.appointmentResource.findMany({
      where: {
        resourceId: { in: required.map((row) => row.resourceId) },
        blocksSlot: true,
        ...(excludeAppointmentId === undefined
          ? {}
          : { appointmentId: { not: excludeAppointmentId } }),
        ...overlapping(dayStart, dayEnd),
      },
      select: { startsAt: true, endsAt: true },
    });

    return mergeIntervals(busy.map(toRowInterval));
  }

  private async tenantTimezone(): Promise<string> {
    const tenantId = this.tenantContext.getTenantId();

    if (!tenantId) {
      throw new TenantContextMissingError('Tenant', 'read availability');
    }

    const tenant = await this.prisma.scoped.tenant.findFirst({
      where: { id: tenantId },
      select: { timezone: true },
    });

    if (!tenant) {
      throw new NotFoundException('El negocio no existe o fue dado de baja');
    }

    return tenant.timezone;
  }

  private async assertBranchExists(branchId: string): Promise<void> {
    const branch = await this.prisma.scoped.branch.findFirst({
      where: { id: branchId },
      select: { id: true },
    });

    if (!branch) {
      throw new NotFoundException('La sucursal no existe');
    }
  }
}

/** Una hora de pared de ese día, en la zona del negocio, como instantes. */
function toInterval(
  window: WallClockWindow,
  date: string,
  timezone: string,
): Interval {
  return {
    start: zonedWallTimeToUtc(date, window.fromMinutes, timezone),
    end: zonedWallTimeToUtc(date, window.toMinutes, timezone),
  };
}

function toRowInterval(row: { startsAt: Date; endsAt: Date }): Interval {
  return { start: row.startsAt, end: row.endsAt };
}

/**
 * El `where` de "pisa el día": arranca antes de que termine y termina después
 * de que empieza. Con un `startsAt` entre las dos puntas se perdería un turno
 * que viene de la noche anterior.
 */
function overlapping(
  dayStart: Date,
  dayEnd: Date,
): { startsAt: { lt: Date }; endsAt: { gt: Date } } {
  return { startsAt: { lt: dayEnd }, endsAt: { gt: dayStart } };
}

function groupBy<T, V>(
  rows: T[],
  key: (row: T) => string,
  value: (row: T) => V,
): Map<string, V[]> {
  const grouped = new Map<string, V[]>();

  for (const row of rows) {
    const existing = grouped.get(key(row));

    if (existing) {
      existing.push(value(row));
    } else {
      grouped.set(key(row), [value(row)]);
    }
  }

  return grouped;
}

function toAppointmentResponse(row: AppointmentRow): AppointmentResponseDto {
  return {
    id: row.id,
    branch: row.branch,
    employee: {
      id: row.employee.id,
      name: `${row.employee.user.firstName} ${row.employee.user.lastName}`,
    },
    customer: row.customer,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    status: row.status,
    createdVia: row.createdVia,
    totalPriceCents: row.totalPriceCents,
    depositAmountCents: row.depositAmountCents,
    depositPaid: row.depositPaid,
    notes: row.notes,
    services: row.services.map((service) => ({
      serviceId: service.serviceId,
      name: service.service.name,
      durationMinutes: service.durationMinutes,
      priceCents: service.priceCents,
    })),
    resources: row.resources.map((resource) => ({
      resourceId: resource.resourceId,
      name: resource.resource.name,
    })),
    rescheduledFromId: row.rescheduledFromId,
    rescheduledToId: row.rescheduledTo?.id ?? null,
    canceledAt: row.canceledAt,
    cancellationReason: row.cancellationReason,
    recurrenceGroupId: row.recurrenceGroupId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Cuánto dura, cuánto sale y cuánta seña pide el turno entero.
 *
 * La duración incluye los buffers: si alguien se hace corte y color seguido, el
 * profesional queda ocupado la suma de las dos cosas más sus dos limpiezas.
 * La seña es `null` cuando ningún servicio pide seña, no cero: son cosas
 * distintas y el CHECK de la base distingue.
 */
function totalsOf(services: ServiceSnapshot[]): {
  minutes: number;
  priceCents: number;
  depositCents: number | null;
} {
  const deposits = services
    .map((service) => service.depositAmountCents)
    .filter((amount): amount is number => amount !== null);

  return {
    minutes: services.reduce(
      (total, service) =>
        total + service.durationMinutes + service.bufferAfterMinutes,
      0,
    ),
    priceCents: services.reduce(
      (total, service) => total + service.priceCents,
      0,
    ),
    depositCents:
      deposits.length === 0
        ? null
        : deposits.reduce((total, amount) => total + amount, 0),
  };
}

function addMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * 60_000);
}

/** Días de diferencia entre dos fechas de calendario. */
function daysBetween(from: string, to: string): number {
  const parse = (value: string): number => {
    const [year, month, day] = value.split('-').map(Number);

    return Date.UTC(year, month - 1, day);
  };

  return (parse(to) - parse(from)) / 86_400_000;
}

/**
 * Traduce el choque contra un EXCLUDE constraint al 409 que corresponde.
 *
 * Es el único camino por el que se detecta un doble-booking real (dos requests
 * simultáneas), así que el mensaje tiene que decir **qué** se pisó: si fue la
 * agenda del profesional o un recurso que ya estaba tomado. Cualquier otro
 * error pasa de largo sin tocarse.
 */
function scheduleConflictOr(error: unknown): unknown {
  const constraint = exclusionViolationConstraint(error);

  if (constraint === null) {
    return error;
  }

  return new ConflictException(
    constraint === 'appointment_resources_no_overlap'
      ? 'Alguien tomó ese horario primero: el recurso que necesita este ' +
          'servicio ya está reservado'
      : 'Alguien tomó ese horario primero: el profesional ya tiene otro turno ' +
          'que se pisa con este',
  );
}

/** Deja solo las claves que vinieron (`undefined` = "no filtrar por esto"). */
function pickDefined<T extends object>(values: Record<string, unknown>): T {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as T;
}

/** El texto de un `ConflictException`, venga como string o dentro de un objeto. */
function conflictMessage(error: ConflictException): string {
  const response = error.getResponse();

  if (typeof response === 'string') {
    return response;
  }

  const message = (response as { message?: unknown }).message;

  return typeof message === 'string' ? message : error.message;
}
