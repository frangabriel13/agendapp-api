import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AppointmentStatus, Prisma } from '@prisma/client';
import { TenantContextMissingError } from '../../common/errors/tenant-context-missing.error';
import { MailService } from '../../common/mail';
import type { BookingMailAppointment } from '../../common/mail/templates/booking';
import { TenantContextService } from '../../common/tenant-context';
import {
  dateToDateOnly,
  parseDateOnly,
} from '../../common/utils/date-only.util';
import { dateToTimeOfDayOrNull } from '../../common/utils/time-of-day.util';
import {
  MINUTES_PER_DAY,
  zonedDateOnly,
  zonedWallTimeToUtc,
} from '../../common/utils/timezone.util';
import { normalizePhone } from '../../common/utils/phone.util';
import { scopedCreate } from '../../prisma/extensions';
import { PrismaService } from '../../prisma/prisma.service';
import { AppointmentsService } from '../appointments/appointments.service';
import {
  BLOCKING_STATUSES,
  type BookingWindow,
} from '../appointments/availability';
import type {
  AppointmentResponseDto,
  CreateAppointmentDto,
} from '../appointments/dto/appointment.dto';
import type {
  AvailabilityQueryDto,
  AvailabilityResponseDto,
} from '../appointments/dto/availability.dto';
import { PaymentsService } from '../payments/payments.service';
import type {
  CreatePublicBookingDto,
  PublicBookingResponseDto,
} from './dto/public-booking.dto';
import type {
  PublicBranchDto,
  PublicServiceGroupDto,
} from './dto/public-catalog.dto';
import type { PublicBusinessDto } from './dto/public-portal.dto';

/** El nombre del grupo donde caen los servicios sin categoría. */
const UNCATEGORIZED = 'Otros';

const BRANCH_SELECT = {
  id: true,
  name: true,
  address: true,
  phone: true,
  businessHours: {
    select: {
      dayOfWeek: true,
      isClosed: true,
      opensAt: true,
      closesAt: true,
    },
    orderBy: { dayOfWeek: 'asc' },
  },
} satisfies Prisma.BranchSelect;

const SERVICE_SELECT = {
  id: true,
  name: true,
  description: true,
  durationMinutes: true,
  priceCents: true,
  depositAmountCents: true,
  color: true,
  category: { select: { id: true, name: true, displayOrder: true } },
} satisfies Prisma.ServiceSelect;

type ServiceRow = Prisma.ServiceGetPayload<{ select: typeof SERVICE_SELECT }>;

const MS_PER_DAY = 24 * 60 * 60 * 1_000;

/** Las reglas de reserva del negocio, ya resueltas a instantes. */
interface BookingPolicy {
  enabled: boolean;
  timezone: string;
  currency: string;
  window: BookingWindow;
}

/**
 * Lo que el portal público muestra de un negocio.
 *
 * **Todo entra por `PublicTenantGuard`**, que ya resolvió el negocio por el
 * `:slug` y lo montó en el contexto. Por eso acá se usa `prisma.scoped` igual
 * que en el panel: el aislamiento entre negocios es el mismo de siempre, y no
 * hay una segunda forma de filtrar por tenant que pueda salir mal.
 *
 * La regla que atraviesa el archivo: **acá solo sale lo que el negocio ya
 * publica en su vidriera.** Nada de plan, suscripción, empleados, notas de
 * clientes ni fechas internas. Cuando dudes, no lo pongas: agregarlo después es
 * un cambio aditivo, sacarlo es romper el contrato.
 */
@Injectable()
export class PublicService {
  private readonly logger = new Logger(PublicService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly appointments: AppointmentsService,
    private readonly payments: PaymentsService,
    private readonly mail: MailService,
  ) {}

  async findBusiness(): Promise<PublicBusinessDto> {
    const tenantId = this.requireTenantId();

    const tenant = await this.prisma.scoped.tenant.findFirst({
      where: { id: tenantId },
      select: {
        slug: true,
        businessName: true,
        timezone: true,
        currency: true,
        language: true,
        branding: {
          select: {
            displayName: true,
            description: true,
            logoUrl: true,
            primaryColor: true,
          },
        },
        settings: {
          select: {
            publicBookingEnabled: true,
            minBookingNoticeMinutes: true,
            maxBookingDaysAhead: true,
            cancellationPolicyHours: true,
          },
        },
      },
    });

    if (!tenant) {
      throw new NotFoundException('No encontramos ese negocio');
    }

    const { branding, settings } = tenant;

    return {
      slug: tenant.slug,
      // El branding y los settings se crean junto con el negocio en el
      // registro, así que faltar es data corrupta. El portal igual no se cae
      // por eso: cae al nombre del registro y a los defaults del schema.
      displayName: branding?.displayName ?? tenant.businessName,
      description: branding?.description ?? null,
      logoUrl: branding?.logoUrl ?? null,
      primaryColor: branding?.primaryColor ?? null,
      timezone: tenant.timezone,
      currency: tenant.currency,
      language: tenant.language,
      booking: {
        enabled: settings?.publicBookingEnabled ?? true,
        minNoticeMinutes: settings?.minBookingNoticeMinutes ?? 0,
        maxDaysAhead: settings?.maxBookingDaysAhead ?? 0,
        // Constante y no un setting: `requireDepositForBooking` gobierna el
        // mostrador, donde la clienta está enfrente. Acá se cobra siempre que
        // el servicio tenga seña.
        depositRequired: true,
        cancellationPolicyHours: settings?.cancellationPolicyHours ?? 0,
      },
    };
  }

  /** Solo las activas: una sucursal cerrada no es una opción para nadie. */
  async findBranches(): Promise<PublicBranchDto[]> {
    const branches = await this.prisma.scoped.branch.findMany({
      where: { isActive: true },
      select: BRANCH_SELECT,
      orderBy: { name: 'asc' },
    });

    return branches.map((branch) => ({
      id: branch.id,
      name: branch.name,
      address: branch.address,
      phone: branch.phone,
      businessHours: branch.businessHours.map((hour) => ({
        dayOfWeek: hour.dayOfWeek,
        isClosed: hour.isClosed,
        opensAt: dateToTimeOfDayOrNull(hour.opensAt),
        closesAt: dateToTimeOfDayOrNull(hour.closesAt),
      })),
    }));
  }

  /**
   * Los servicios reservables, agrupados por categoría.
   *
   * **Las dos condiciones son necesarias y distintas.** `isActive` es "existe";
   * `publiclyBookable` es "un desconocido lo puede elegir solo". Un retoque de
   * garantía está activo y no va acá.
   */
  async findServices(): Promise<PublicServiceGroupDto[]> {
    const services = await this.prisma.scoped.service.findMany({
      where: { isActive: true, publiclyBookable: true },
      select: SERVICE_SELECT,
      orderBy: { name: 'asc' },
    });

    return groupByCategory(services);
  }

  /**
   * Los huecos que el portal puede ofrecer ese día.
   *
   * Es **el mismo cálculo que el panel** —`AppointmentsService.findAvailability`,
   * misma validación de servicios, misma duración, mismos bloqueos— más la
   * ventana de reserva. No hay una segunda implementación: si la hubiera,
   * tarde o temprano ofrecería un horario que el alta rechaza, que es
   * exactamente el 409 inexplicable que ya nos costó una vez.
   *
   * Un día fuera de la ventana no es un error: devuelve `slots: []`. El portal
   * ya sabe por `GET /public/:slug` hasta cuándo se puede reservar, así que
   * puede deshabilitar esos días; contestar 400 no le daría nada y rompería el
   * calendario de quien mira un mes entero.
   */
  async findAvailability(
    query: AvailabilityQueryDto,
  ): Promise<AvailabilityResponseDto> {
    const policy = await this.bookingPolicy();

    this.assertBookingEnabled(policy);

    return this.appointments.findAvailability(query, policy.window);
  }

  /**
   * Agenda un turno pedido por alguien sin cuenta.
   *
   * El orden es el que es por un motivo cada paso:
   *
   * 1. **Se valida contra la disponibilidad real, no contra la ventana a
   *    mano.** Se pide el mismo día que vería el portal y se busca el
   *    `startsAt` entre los slots. Así "está dentro de la ventana", "la
   *    sucursal abre", "alguien lo presta" y "el hueco está libre" salen de una
   *    sola fuente. Chequear la ventana por separado acá sería escribir la
   *    regla dos veces.
   * 2. **De ahí sale el profesional cuando no lo eligieron** (`employeeId`
   *    ausente = "cualquiera"): entre los que tienen el hueco libre, el que
   *    menos turnos tiene ese día. Tomar siempre el primero de la lista le
   *    daría todas las reservas web a quien ordene primero.
   * 3. **Recién después se toca la ficha del cliente.** Si el hueco no existe,
   *    no se crea a nadie: un 409 no debería dejar clientes fantasma.
   * 4. El alta real es `createFromPortal`, que es donde vive el EXCLUDE
   *    constraint que impide el doble-booking de verdad.
   * 5. La seña y los mails, al final. Si el proveedor de pagos no contesta, el
   *    turno queda en `PENDING_PAYMENT` sin link y **se libera solo** a los
   *    `ABANDONED_HOLD_MINUTES`: por eso este método puede propagar el 502 sin
   *    dejar la agenda tapada.
   */
  async book(dto: CreatePublicBookingDto): Promise<PublicBookingResponseDto> {
    const policy = await this.bookingPolicy();

    this.assertBookingEnabled(policy);

    const startsAt = new Date(dto.startsAt);
    const employeeId = await this.resolveEmployee(dto, startsAt, policy);
    const customerId = await this.resolveCustomer(dto.customer);

    const booking: CreateAppointmentDto = {
      branchId: dto.branchId,
      employeeId,
      customerId,
      serviceIds: dto.serviceIds,
      startsAt: dto.startsAt,
      notes: dto.notes ?? null,
    };

    const appointment = await this.appointments.createFromPortal(booking);
    const deposit = await this.chargeDeposit(appointment);

    await this.announce(appointment, dto, deposit);

    return {
      appointmentId: appointment.id,
      startsAt: appointment.startsAt,
      endsAt: appointment.endsAt,
      status: appointment.status,
      branchName: appointment.branch.name,
      employeeName: appointment.employee.name,
      services: appointment.services.map((service) => ({
        id: service.serviceId,
        name: service.name,
        durationMinutes: service.durationMinutes,
        priceCents: service.priceCents,
      })),
      totalPriceCents: appointment.totalPriceCents,
      currency: policy.currency,
      deposit,
    };
  }

  /**
   * Quién atiende, cuando el portal no lo dijo, y de paso la verificación de
   * que el hueco existe.
   *
   * Las dos cosas juntas y no separadas porque salen de la misma consulta: los
   * candidatos son exactamente `slot.employees`, la lista que el propio portal
   * mostró.
   */
  private async resolveEmployee(
    dto: CreatePublicBookingDto,
    startsAt: Date,
    policy: BookingPolicy,
  ): Promise<string> {
    const availability = await this.appointments.findAvailability(
      {
        branchId: dto.branchId,
        serviceIds: dto.serviceIds,
        date: zonedDateOnly(startsAt, policy.timezone),
        ...(dto.employeeId === undefined ? {} : { employeeId: dto.employeeId }),
      },
      policy.window,
    );

    const slot = availability.slots.find(
      (candidate) => candidate.startsAt.getTime() === startsAt.getTime(),
    );

    if (!slot) {
      // Mismo mensaje se haya llenado el hueco, se haya cerrado la sucursal o
      // se haya pedido un horario fuera de la ventana: para quien reserva la
      // acción es la misma —elegir otro— y el portal ya muestra por qué.
      throw new ConflictException(
        'Ese horario ya no está disponible. Elegí otro.',
      );
    }

    if (dto.employeeId !== undefined) {
      return dto.employeeId;
    }

    return this.leastBusy(
      slot.employees.map((employee) => employee.employeeId),
      startsAt,
      policy.timezone,
    );
  }

  /**
   * De los candidatos, el que menos turnos tiene ese día.
   *
   * Reparte el trabajo de "cualquiera" en vez de dárselo siempre al mismo. El
   * desempate es por id y no al azar: con dos personas igual de libres, dos
   * corridas iguales tienen que dar lo mismo o los tests no fijan nada.
   */
  private async leastBusy(
    employeeIds: string[],
    startsAt: Date,
    timezone: string,
  ): Promise<string> {
    const sorted = [...employeeIds].sort();
    const first = sorted[0];

    if (first === undefined) {
      // Inalcanzable: un slot sin nadie libre no se devuelve.
      throw new ConflictException('Ese horario ya no está disponible.');
    }

    if (sorted.length === 1) {
      return first;
    }

    const date = zonedDateOnly(startsAt, timezone);
    const booked = await this.prisma.scoped.appointment.findMany({
      where: {
        employeeId: { in: sorted },
        status: { in: [...BLOCKING_STATUSES] },
        startsAt: {
          gte: zonedWallTimeToUtc(date, 0, timezone),
          lt: zonedWallTimeToUtc(date, MINUTES_PER_DAY, timezone),
        },
      },
      select: { employeeId: true },
    });

    // Se cuenta en memoria y no con un `groupBy`: son los turnos de un día de
    // un puñado de personas, y el `groupBy` no devuelve fila para quien tiene
    // cero — que es justamente a quien hay que elegir.
    const counts = new Map<string, number>();

    for (const row of booked) {
      counts.set(row.employeeId, (counts.get(row.employeeId) ?? 0) + 1);
    }

    return sorted.reduce((best, candidate) =>
      (counts.get(candidate) ?? 0) < (counts.get(best) ?? 0) ? candidate : best,
    );
  }

  /**
   * La ficha de quien reserva: la que ya existe con ese teléfono, o una nueva.
   *
   * ⚠️ **Una ficha existente no se pisa con lo que vino del formulario.** Si el
   * negocio la tiene cargada como "María González" y alguien escribe "maria",
   * gana lo que el negocio cargó: el panel es la fuente de verdad de su propia
   * clientela, y un formulario anónimo no puede editarla. Tampoco hace falta
   * para nada de lo que sigue — el mail se manda con el nombre que la persona
   * acaba de escribir.
   *
   * El `catch` cubre la carrera de dos reservas simultáneas con el mismo
   * teléfono: una pasa el `findFirst` y choca contra el unique parcial de
   * `customers`. La respuesta correcta ahí no es un error sino la ficha que
   * ganó, que es lo mismo que habría devuelto el `findFirst` un instante
   * después.
   */
  private async resolveCustomer(customer: {
    firstName: string;
    lastName?: string | null;
    phone: string;
    email?: string | null;
  }): Promise<string> {
    const phoneNormalized = normalizePhone(customer.phone);
    const existing = await this.findCustomerByPhone(phoneNormalized);

    if (existing) {
      return existing;
    }

    try {
      const created = await this.prisma.scoped.customer.create({
        data: scopedCreate<Prisma.CustomerUncheckedCreateInput>({
          firstName: customer.firstName,
          lastName: customer.lastName ?? null,
          phone: customer.phone,
          phoneNormalized,
          email: customer.email ?? null,
        }),
        select: { id: true },
      });

      return created.id;
    } catch (error) {
      const raced =
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
          ? await this.findCustomerByPhone(phoneNormalized)
          : null;

      if (raced === null) {
        throw error;
      }

      return raced;
    }
  }

  private async findCustomerByPhone(
    phoneNormalized: string,
  ): Promise<string | null> {
    const found = await this.prisma.scoped.customer.findFirst({
      where: { phoneNormalized },
      select: { id: true },
    });

    return found?.id ?? null;
  }

  /**
   * Abre el cobro de la seña, si hay una.
   *
   * Se mira el **estado del turno** y no el monto: `createFromPortal` ya
   * resolvió si corresponde esperar el pago, y volver a decidirlo acá sería la
   * misma regla escrita en dos lados.
   */
  private async chargeDeposit(
    appointment: AppointmentResponseDto,
  ): Promise<PublicBookingResponseDto['deposit']> {
    if (appointment.status !== AppointmentStatus.PENDING_PAYMENT) {
      return null;
    }

    const checkout = await this.payments.createCheckout(appointment.id, {});

    return {
      amountCents: checkout.amountCents,
      currency: checkout.currency,
      checkoutUrl: checkout.checkoutUrl,
    };
  }

  /**
   * Los dos mails: la confirmación a quien reservó y el aviso al negocio.
   *
   * **Ninguno puede voltear la reserva.** `MailService` ya atrapa sus propios
   * errores, pero además acá se ignora el resultado a propósito: el turno
   * existe, y contestarle un 500 a alguien que ya tiene el hueco tomado lo
   * dejaría creyendo que no reservó.
   *
   * A quien reservó se le escribe **al mail que acaba de tipear**, no al que la
   * ficha pueda tener guardado, y con el nombre que tipeó: si el teléfono ya
   * era de otra persona, mandarle el mail a esa otra persona sería filtrarle un
   * turno ajeno.
   */
  private async announce(
    appointment: AppointmentResponseDto,
    dto: CreatePublicBookingDto,
    deposit: PublicBookingResponseDto['deposit'],
  ): Promise<void> {
    const context = await this.mailContext(appointment);

    if (context === null) {
      return;
    }

    const { mail, businessEmail } = context;
    const awaitingDeposit = deposit !== null;

    if (dto.customer.email) {
      await this.mail.sendBookingConfirmation({
        to: dto.customer.email,
        firstName: dto.customer.firstName,
        appointment: mail,
        ...(deposit === null
          ? {}
          : {
              deposit: {
                amountCents: deposit.amountCents,
                currency: deposit.currency,
                url: deposit.checkoutUrl,
              },
            }),
        businessPhone: context.businessPhone,
      });
    }

    if (businessEmail !== null) {
      await this.mail.sendBookingNotice({
        to: businessEmail,
        appointment: mail,
        customerName: [dto.customer.firstName, dto.customer.lastName]
          .filter((part) => Boolean(part))
          .join(' '),
        customerPhone: dto.customer.phone,
        awaitingDeposit,
      });
    }
  }

  /** Lo que los mails necesitan y el turno no trae: dirección, zona, casillas. */
  private async mailContext(appointment: AppointmentResponseDto): Promise<{
    mail: BookingMailAppointment;
    businessEmail: string | null;
    businessPhone: string | null;
  } | null> {
    const tenantId = this.requireTenantId();

    const [tenant, branch] = await Promise.all([
      this.prisma.scoped.tenant.findFirst({
        where: { id: tenantId },
        select: {
          businessName: true,
          timezone: true,
          owner: { select: { email: true } },
        },
      }),
      this.prisma.scoped.branch.findFirst({
        where: { id: appointment.branch.id },
        select: { name: true, address: true, phone: true },
      }),
    ]);

    if (!tenant || !branch) {
      // El turno ya está agendado: quedarse sin mail es peor que nada, pero
      // muchísimo mejor que perder la reserva por no poder escribirlo.
      this.logger.warn(
        { appointmentId: appointment.id },
        'No se pudieron armar los mails de la reserva',
      );

      return null;
    }

    return {
      mail: {
        businessName: tenant.businessName,
        startsAt: appointment.startsAt,
        timezone: tenant.timezone,
        serviceNames: appointment.services.map((service) => service.name),
        employeeName: appointment.employee.name,
        branchName: branch.name,
        branchAddress: branch.address,
      },
      businessEmail: tenant.owner.email,
      businessPhone: branch.phone,
    };
  }

  /**
   * Las reglas de reserva del negocio, resueltas a instantes.
   *
   * `notAfter` se arma sumando **días de calendario** sobre la fecha del
   * negocio y recién ahí se pasa a instante: sumar `maxDaysAhead * 24h` daría
   * una hora distinta el día que cambia la hora, y el último día reservable
   * quedaría cortado o estirado.
   */
  private async bookingPolicy(now = new Date()): Promise<BookingPolicy> {
    const tenantId = this.requireTenantId();

    const tenant = await this.prisma.scoped.tenant.findFirst({
      where: { id: tenantId },
      select: {
        timezone: true,
        currency: true,
        settings: {
          select: {
            publicBookingEnabled: true,
            minBookingNoticeMinutes: true,
            maxBookingDaysAhead: true,
          },
        },
      },
    });

    if (!tenant) {
      throw new NotFoundException('No encontramos ese negocio');
    }

    const settings = tenant.settings;
    const timezone = tenant.timezone;
    const today = zonedDateOnly(now, timezone);
    const lastDay = dateToDateOnly(
      new Date(
        parseDateOnly(today).getTime() +
          (settings?.maxBookingDaysAhead ?? 0) * MS_PER_DAY,
      ),
    );

    return {
      enabled: settings?.publicBookingEnabled ?? false,
      timezone,
      currency: tenant.currency,
      window: {
        notBefore: new Date(
          now.getTime() + (settings?.minBookingNoticeMinutes ?? 0) * 60_000,
        ),
        notAfter: zonedWallTimeToUtc(lastDay, MINUTES_PER_DAY, timezone),
      },
    };
  }

  /**
   * 403 y no 404: el negocio existe y su portal se ve. Lo que está apagado son
   * las reservas, que es justo lo que `booking.enabled` viene anunciando desde
   * la primera llamada.
   */
  private assertBookingEnabled(policy: BookingPolicy): void {
    if (!policy.enabled) {
      throw new ForbiddenException(
        'Este negocio no está tomando reservas por la web en este momento',
      );
    }
  }

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();

    if (!tenantId) {
      // Inalcanzable pasando por `PublicTenantGuard`. Si aparece, es que
      // alguien montó una ruta del portal sin `@PublicTenant()`.
      throw new TenantContextMissingError('Tenant', 'read public portal');
    }

    return tenantId;
  }
}

/**
 * Arma los grupos respetando el `displayOrder` de las categorías.
 *
 * Los sin categoría van al final en un grupo con `id: null`. **No se los
 * esconde**: un servicio sin categorizar es un descuido de carga, y sacarlo del
 * portal convertiría ese descuido en plata que no entra.
 */
function groupByCategory(services: ServiceRow[]): PublicServiceGroupDto[] {
  const groups = new Map<
    string,
    { id: string | null; name: string; order: number; services: ServiceRow[] }
  >();

  for (const service of services) {
    const key = service.category?.id ?? '';
    const group = groups.get(key);

    if (group) {
      group.services.push(service);
      continue;
    }

    groups.set(key, {
      id: service.category?.id ?? null,
      name: service.category?.name ?? UNCATEGORIZED,
      // `Infinity` empuja a los sin categoría al final sin necesidad de un
      // segundo criterio de orden.
      order: service.category?.displayOrder ?? Number.POSITIVE_INFINITY,
      services: [service],
    });
  }

  return [...groups.values()]
    .sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
    .map((group) => ({
      id: group.id,
      name: group.name,
      services: group.services.map((service) => ({
        id: service.id,
        name: service.name,
        description: service.description,
        durationMinutes: service.durationMinutes,
        priceCents: service.priceCents,
        depositAmountCents: service.depositAmountCents,
        color: service.color,
      })),
    }));
}
