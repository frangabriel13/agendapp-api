import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantContextMissingError } from '../../common/errors/tenant-context-missing.error';
import { TenantContextService } from '../../common/tenant-context';
import {
  dateToDateOnly,
  parseDateOnly,
} from '../../common/utils/date-only.util';
import {
  dateToTimeOfDayOrNull,
  timeOfDayToDate,
  timeOfDayToMinutes,
} from '../../common/utils/time-of-day.util';
import { scopedCreate } from '../../prisma/extensions';
import {
  PrismaService,
  type ScopedTransactionClient,
} from '../../prisma/prisma.service';
import type {
  BranchDetailResponseDto,
  BranchResponseDto,
  CreateBranchDto,
  ListBranchesQueryDto,
  UpdateBranchDto,
} from './dto/branch.dto';
import {
  DAYS_IN_WEEK,
  type BusinessHourDto,
  type BusinessHourResponseDto,
  type SetBusinessHoursDto,
} from './dto/business-hours.dto';
import type {
  CreateSpecialDayDto,
  ListSpecialDaysQueryDto,
  SpecialDayResponseDto,
  UpdateSpecialDayDto,
} from './dto/special-day.dto';

const BRANCH_SELECT = {
  id: true,
  name: true,
  address: true,
  phone: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.BranchSelect;

const BUSINESS_HOUR_SELECT = {
  dayOfWeek: true,
  isClosed: true,
  opensAt: true,
  closesAt: true,
} satisfies Prisma.BranchBusinessHourSelect;

const SPECIAL_DAY_SELECT = {
  id: true,
  date: true,
  isClosed: true,
  opensAt: true,
  closesAt: true,
  description: true,
} satisfies Prisma.BranchSpecialDaySelect;

/** Horario con el que nace una sucursal si no mandan uno. */
const DEFAULT_OPENS_AT = '09:00';
const DEFAULT_CLOSES_AT = '18:00';
const WEEKEND_DAYS = new Set([0, 6]);

/** La parte "horario" de un día, ya lista para la base. */
type ScheduleRow = {
  isClosed: boolean;
  opensAt: Date | null;
  closesAt: Date | null;
};

/**
 * Sucursales: el primer módulo de negocio del proyecto.
 *
 * Todo pasa por `prisma.scoped`, así que ninguna query filtra por `tenantId` a
 * mano — la extension lo inyecta. Lo único que necesita el tenant explícito es
 * leer el plan, porque `Tenant` está exento del scoping.
 *
 * Los horarios y los días especiales cuelgan de la sucursal, no del tenant: por
 * eso cada operación arranca por `findBranchOrFail`, que devuelve 404 si la
 * sucursal no existe *o* es de otro negocio. Es 404 y no 403 a propósito: un id
 * ajeno no tiene por qué enterarse de que existe.
 */
@Injectable()
export class BranchesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async create(dto: CreateBranchDto): Promise<BranchDetailResponseDto> {
    const tenantId = this.requireTenantId('create');
    const week = this.toWeekRows(dto.businessHours ?? defaultWeek());

    try {
      const branch = await this.prisma.scoped.$transaction(async (tx) => {
        await this.assertBranchQuotaAvailable(tenantId, tx);

        const created = await tx.branch.create({
          data: scopedCreate<Prisma.BranchUncheckedCreateInput>({
            name: dto.name,
            address: dto.address ?? null,
            phone: dto.phone ?? null,
          }),
          select: BRANCH_SELECT,
        });

        // La sucursal y sus 7 días nacen juntos: una sucursal a medio crear, sin
        // horarios, no daría ni un turno disponible y nadie sabría por qué.
        await tx.branchBusinessHour.createMany({
          data: week.map((row) =>
            scopedCreate<Prisma.BranchBusinessHourUncheckedCreateInput>({
              ...row,
              branchId: created.id,
            }),
          ),
        });

        return created;
      });

      return {
        ...branch,
        businessHours: await this.loadBusinessHours(branch.id),
      };
    } catch (error) {
      throw duplicateNameOr(error);
    }
  }

  async findAll(query: ListBranchesQueryDto): Promise<BranchResponseDto[]> {
    return this.prisma.scoped.branch.findMany({
      where: query.isActive === undefined ? {} : { isActive: query.isActive },
      select: BRANCH_SELECT,
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string): Promise<BranchDetailResponseDto> {
    const branch = await this.findBranchOrFail(id);

    return { ...branch, businessHours: await this.loadBusinessHours(id) };
  }

  async update(id: string, dto: UpdateBranchDto): Promise<BranchResponseDto> {
    const current = await this.findBranchOrFail(id);

    const data = pickDefined<Prisma.BranchUpdateInput>({
      name: dto.name,
      address: dto.address,
      phone: dto.phone,
      isActive: dto.isActive,
    });

    if (isEmpty(data)) {
      return current;
    }

    try {
      return await this.prisma.scoped.branch.update({
        where: { id, deletedAt: null },
        data,
        select: BRANCH_SELECT,
      });
    } catch (error) {
      throw duplicateNameOr(error);
    }
  }

  /**
   * Baja lógica: la extension convierte el `delete` en un `deletedAt`. Los
   * horarios y los días especiales quedan en la base pero dejan de ser
   * alcanzables, porque solo se llega a ellos a través de la sucursal.
   */
  async remove(id: string): Promise<void> {
    await this.findBranchOrFail(id);
    await this.prisma.scoped.branch.delete({ where: { id } });
  }

  async findBusinessHours(
    branchId: string,
  ): Promise<BusinessHourResponseDto[]> {
    await this.findBranchOrFail(branchId);

    return this.loadBusinessHours(branchId);
  }

  /**
   * Reemplaza la semana entera. Borrar y volver a insertar (en vez de siete
   * upserts) garantiza que no quede un día del set anterior mezclado con el
   * nuevo: la semana que se guarda es exactamente la que mandaron.
   */
  async setBusinessHours(
    branchId: string,
    dto: SetBusinessHoursDto,
  ): Promise<BusinessHourResponseDto[]> {
    await this.findBranchOrFail(branchId);
    const week = this.toWeekRows(dto.days);

    await this.prisma.scoped.$transaction(async (tx) => {
      await tx.branchBusinessHour.deleteMany({ where: { branchId } });
      await tx.branchBusinessHour.createMany({
        data: week.map((row) =>
          scopedCreate<Prisma.BranchBusinessHourUncheckedCreateInput>({
            ...row,
            branchId,
          }),
        ),
      });
    });

    return this.loadBusinessHours(branchId);
  }

  async findSpecialDays(
    branchId: string,
    query: ListSpecialDaysQueryDto,
  ): Promise<SpecialDayResponseDto[]> {
    await this.findBranchOrFail(branchId);

    const date = pickDefined<Prisma.DateTimeFilter>({
      gte: query.from === undefined ? undefined : parseDateOnly(query.from),
      lte: query.to === undefined ? undefined : parseDateOnly(query.to),
    });

    const days = await this.prisma.scoped.branchSpecialDay.findMany({
      where: { branchId, ...(isEmpty(date) ? {} : { date }) },
      select: SPECIAL_DAY_SELECT,
      orderBy: { date: 'asc' },
    });

    return days.map(toSpecialDayResponse);
  }

  async createSpecialDay(
    branchId: string,
    dto: CreateSpecialDayDto,
  ): Promise<SpecialDayResponseDto> {
    await this.findBranchOrFail(branchId);

    const schedule = this.toScheduleRow({
      isClosed: dto.isClosed ?? true,
      opensAt: dto.opensAt,
      closesAt: dto.closesAt,
    });

    try {
      const created = await this.prisma.scoped.branchSpecialDay.create({
        data: scopedCreate<Prisma.BranchSpecialDayUncheckedCreateInput>({
          branchId,
          date: parseDateOnly(dto.date),
          description: dto.description ?? null,
          ...schedule,
        }),
        select: SPECIAL_DAY_SELECT,
      });

      return toSpecialDayResponse(created);
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictException(
          `La sucursal ya tiene un día especial cargado para el ${dto.date}`,
        );
      }
      throw error;
    }
  }

  async updateSpecialDay(
    branchId: string,
    specialDayId: string,
    dto: UpdateSpecialDayDto,
  ): Promise<SpecialDayResponseDto> {
    const current = await this.findSpecialDayOrFail(branchId, specialDayId);

    // El PATCH se resuelve contra el estado actual: marcar `isClosed` sin mandar
    // horas tiene que limpiarlas, y reabrir un día que estaba cerrado tiene que
    // exigirlas. Por eso primero se mezcla y después se valida el resultado.
    const schedule = this.toScheduleRow({
      isClosed: dto.isClosed ?? current.isClosed,
      opensAt: dto.opensAt ?? current.opensAt ?? undefined,
      closesAt: dto.closesAt ?? current.closesAt ?? undefined,
    });

    const updated = await this.prisma.scoped.branchSpecialDay.update({
      where: { id: specialDayId },
      data: {
        ...schedule,
        ...pickDefined<Prisma.BranchSpecialDayUpdateInput>({
          description: dto.description,
        }),
      },
      select: SPECIAL_DAY_SELECT,
    });

    return toSpecialDayResponse(updated);
  }

  async removeSpecialDay(
    branchId: string,
    specialDayId: string,
  ): Promise<void> {
    await this.findSpecialDayOrFail(branchId, specialDayId);
    // Borrado real: `BranchSpecialDay` está en SOFT_DELETE_EXEMPT_MODELS. Un
    // feriado que ya no va simplemente deja de existir.
    await this.prisma.scoped.branchSpecialDay.delete({
      where: { id: specialDayId },
    });
  }

  /**
   * El plan sale del `Tenant`, que está exento del scoping: por eso acá sí hace
   * falta el `tenantId` explícito. `maxBranches` en null es "sin límite" (hoy,
   * solo el plan Empresa).
   *
   * Cuenta las sucursales vivas, activas o no: una sucursal desactivada sigue
   * existiendo y sigue ocupando un lugar del plan. Para liberar uno hay que
   * borrarla.
   *
   * Corre DENTRO de la transacción del alta y, cuando el plan tiene tope,
   * arranca lockeando la fila del negocio. Sin ese lock, dos altas simultáneas
   * contarían las dos lo mismo, verían lugar las dos e insertarían las dos: el
   * negocio terminaría con una sucursal más de las que paga. Con el lock, la
   * segunda espera a que la primera termine y recién ahí cuenta.
   */
  private async assertBranchQuotaAvailable(
    tenantId: string,
    tx: ScopedTransactionClient,
  ): Promise<void> {
    const tenant = await tx.tenant.findFirst({
      where: { id: tenantId },
      select: { plan: { select: { name: true, maxBranches: true } } },
    });

    if (!tenant) {
      throw new NotFoundException('El negocio no existe o fue dado de baja');
    }

    const { maxBranches, name } = tenant.plan;

    if (maxBranches === null) {
      return;
    }

    // Serializa las altas del mismo negocio. Ojo: `tenants` NO se toca acá, se
    // usa como cerrojo — es la fila natural, porque el cupo es del negocio.
    await tx.$queryRaw`SELECT id FROM tenants WHERE id = ${tenantId}::uuid FOR UPDATE`;

    const current = await tx.branch.count();

    if (current >= maxBranches) {
      throw new ForbiddenException(
        `El plan ${name} permite hasta ${maxBranches} ` +
          `${maxBranches === 1 ? 'sucursal' : 'sucursales'}. ` +
          'Para agregar más hay que cambiar de plan.',
      );
    }
  }

  /** Toda operación sobre una sucursal ajena o inexistente muere acá. */
  private async findBranchOrFail(id: string): Promise<BranchResponseDto> {
    const branch = await this.prisma.scoped.branch.findFirst({
      where: { id },
      select: BRANCH_SELECT,
    });

    if (!branch) {
      throw new NotFoundException('La sucursal no existe');
    }

    return branch;
  }

  /** Sin chequear la sucursal: para cuando el caller ya la validó. */
  private async loadBusinessHours(
    branchId: string,
  ): Promise<BusinessHourResponseDto[]> {
    const hours = await this.prisma.scoped.branchBusinessHour.findMany({
      where: { branchId },
      select: BUSINESS_HOUR_SELECT,
      orderBy: { dayOfWeek: 'asc' },
    });

    return hours.map(toBusinessHourResponse);
  }

  private async findSpecialDayOrFail(
    branchId: string,
    specialDayId: string,
  ): Promise<SpecialDayResponseDto> {
    await this.findBranchOrFail(branchId);

    const day = await this.prisma.scoped.branchSpecialDay.findFirst({
      where: { id: specialDayId, branchId },
      select: SPECIAL_DAY_SELECT,
    });

    if (!day) {
      throw new NotFoundException('El día especial no existe en esta sucursal');
    }

    return toSpecialDayResponse(day);
  }

  /** Valida que vengan los 7 días, sin repetir, y los pasa a filas. */
  private toWeekRows(
    days: BusinessHourDto[],
  ): (ScheduleRow & { dayOfWeek: number })[] {
    const seen = new Set<number>();

    for (const day of days) {
      if (seen.has(day.dayOfWeek)) {
        throw new BadRequestException(
          `El día ${day.dayOfWeek} viene repetido: cada día va una sola vez`,
        );
      }
      seen.add(day.dayOfWeek);
    }

    if (seen.size !== DAYS_IN_WEEK) {
      throw new BadRequestException(
        `Hay que mandar los ${DAYS_IN_WEEK} días de la semana (0 = domingo … 6 = sábado)`,
      );
    }

    return days.map((day) => ({
      dayOfWeek: day.dayOfWeek,
      ...this.toScheduleRow(day),
    }));
  }

  /**
   * La regla del horario, que es la misma que el CHECK de la migración: o está
   * cerrado y no lleva horas, o está abierto y lleva las dos, en orden.
   *
   * "Cerrado" gana: si mandan horas junto a `isClosed: true` se descartan en
   * lugar de rebotar el request. Es lo que pasa en cualquier formulario donde
   * el usuario tilda "cerrado" y los inputs de hora se quedan con lo último que
   * tenían escrito.
   */
  private toScheduleRow(day: {
    isClosed?: boolean;
    opensAt?: string;
    closesAt?: string;
  }): ScheduleRow {
    if (day.isClosed === true) {
      return { isClosed: true, opensAt: null, closesAt: null };
    }

    if (day.opensAt === undefined || day.closesAt === undefined) {
      throw new BadRequestException(
        'Un día abierto necesita `opensAt` y `closesAt`; si no atiende, mandá `isClosed: true`',
      );
    }

    if (timeOfDayToMinutes(day.closesAt) <= timeOfDayToMinutes(day.opensAt)) {
      throw new BadRequestException(
        `El horario ${day.opensAt}–${day.closesAt} no cierra después de abrir. ` +
          'Los horarios que cruzan la medianoche todavía no están soportados.',
      );
    }

    return {
      isClosed: false,
      opensAt: timeOfDayToDate(day.opensAt),
      closesAt: timeOfDayToDate(day.closesAt),
    };
  }

  /**
   * Igual que en TenantsService: que falte el contexto no es un error del
   * cliente sino de wiring (falta el guard o el middleware), así que sale por
   * el mismo camino que la extension → 500.
   */
  private requireTenantId(operation: string): string {
    const tenantId = this.tenantContext.getTenantId();

    if (!tenantId) {
      throw new TenantContextMissingError('Tenant', operation);
    }

    return tenantId;
  }
}

/** Lunes a viernes de 09:00 a 18:00, fin de semana cerrado. */
function defaultWeek(): BusinessHourDto[] {
  return Array.from({ length: DAYS_IN_WEEK }, (_, dayOfWeek) =>
    WEEKEND_DAYS.has(dayOfWeek)
      ? { dayOfWeek, isClosed: true }
      : {
          dayOfWeek,
          isClosed: false,
          opensAt: DEFAULT_OPENS_AT,
          closesAt: DEFAULT_CLOSES_AT,
        },
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/**
 * El único UNIQUE que puede romper una sucursal es el índice parcial
 * `(tenant_id, lower(name))` sobre las no borradas.
 */
function duplicateNameOr(error: unknown): unknown {
  return isUniqueViolation(error)
    ? new ConflictException('Ya tenés una sucursal con ese nombre')
    : error;
}

function toBusinessHourResponse(row: {
  dayOfWeek: number;
  isClosed: boolean;
  opensAt: Date | null;
  closesAt: Date | null;
}): BusinessHourResponseDto {
  return {
    dayOfWeek: row.dayOfWeek,
    isClosed: row.isClosed,
    opensAt: dateToTimeOfDayOrNull(row.opensAt),
    closesAt: dateToTimeOfDayOrNull(row.closesAt),
  };
}

function toSpecialDayResponse(row: {
  id: string;
  date: Date;
  isClosed: boolean;
  opensAt: Date | null;
  closesAt: Date | null;
  description: string | null;
}): SpecialDayResponseDto {
  return {
    id: row.id,
    date: dateToDateOnly(row.date),
    isClosed: row.isClosed,
    opensAt: dateToTimeOfDayOrNull(row.opensAt),
    closesAt: dateToTimeOfDayOrNull(row.closesAt),
    description: row.description,
  };
}

/** Deja solo las claves que el PATCH mandó (`undefined` = "no tocar"). */
function pickDefined<T extends object>(values: Record<string, unknown>): T {
  return Object.fromEntries(
    Object.entries(values).filter(([, value]) => value !== undefined),
  ) as T;
}

function isEmpty(data: object): boolean {
  return Object.keys(data).length === 0;
}
