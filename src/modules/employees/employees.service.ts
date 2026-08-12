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
  dateToTimeOfDay,
  timeOfDayToDate,
  timeOfDayToMinutes,
} from '../../common/utils/time-of-day.util';
import { scopedCreate } from '../../prisma/extensions';
import { PrismaService } from '../../prisma/prisma.service';
import { EmployeeInvitationService } from './employee-invitations.service';
import type {
  EmployeeShiftDto,
  EmployeeShiftResponseDto,
  SetEmployeeSchedulesDto,
} from './dto/employee-schedule.dto';
import type {
  CreateTimeOffDto,
  ListTimeOffQueryDto,
  TimeOffResponseDto,
} from './dto/employee-time-off.dto';
import {
  EmployeeStatus,
  type EmployeeDetailResponseDto,
  type EmployeeInvitationResponseDto,
  type EmployeeResponseDto,
  type InviteEmployeeDto,
  type ListEmployeesQueryDto,
  type SetEmployeeBranchesDto,
  type UpdateEmployeeDto,
} from './dto/employee.dto';

const EMPLOYEE_SELECT = {
  id: true,
  role: true,
  isOwner: true,
  isActive: true,
  hiredAt: true,
  bio: true,
  avatarUrl: true,
  createdAt: true,
  updatedAt: true,
  user: {
    select: {
      id: true,
      email: true,
      firstName: true,
      lastName: true,
      phone: true,
      // Solo para derivar `status`. NUNCA sale en la respuesta: el mapper de
      // abajo arma el DTO campo por campo justamente para eso.
      passwordHash: true,
    },
  },
} satisfies Prisma.EmployeeSelect;

const SHIFT_SELECT = {
  id: true,
  branchId: true,
  dayOfWeek: true,
  startsAt: true,
  endsAt: true,
} satisfies Prisma.EmployeeScheduleSelect;

const TIME_OFF_SELECT = {
  id: true,
  employeeId: true,
  branchId: true,
  startsAt: true,
  endsAt: true,
  reason: true,
} satisfies Prisma.EmployeeTimeOffSelect;

type EmployeeRow = Prisma.EmployeeGetPayload<{
  select: typeof EMPLOYEE_SELECT;
}>;

/**
 * Empleados del negocio: alta por invitación, permisos, sucursales donde
 * trabaja cada uno, horario semanal y ausencias.
 *
 * El dueño es una fila más de esta tabla (`isOwner`), así que cuenta para el
 * límite del plan y aparece en los listados — pero está protegido: no se lo
 * puede desactivar, borrar ni cambiar de rol desde acá.
 *
 * Todo va por `prisma.scoped` salvo dos cosas: leer el plan (el `Tenant` está
 * exento del scoping) y crear el `User` del invitado (`User` también lo está,
 * porque es un modelo de auth y no de negocio).
 */
@Injectable()
export class EmployeesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
    private readonly invitations: EmployeeInvitationService,
  ) {}

  /**
   * Da de alta al empleado y devuelve el link de activación.
   *
   * El `User` nace SIN contraseña: existe la cuenta pero no se puede entrar con
   * ella hasta aceptar la invitación (`AuthService.login` rechaza a los usuarios
   * sin `passwordHash`). Todo pasa en una transacción: un empleado sin
   * invitación sería un fantasma sin forma de activarse.
   */
  async invite(dto: InviteEmployeeDto): Promise<EmployeeInvitationResponseDto> {
    await this.assertEmployeeQuotaAvailable();
    await this.assertEmailAvailable(dto.email);
    await this.assertBranchesExist(dto.branchIds ?? []);

    const invitation = await this.invitations.mint();

    const { employee, invitationId } = await this.prisma.scoped
      .$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email: dto.email,
            passwordHash: null,
            firstName: dto.firstName,
            lastName: dto.lastName,
            phone: dto.phone ?? null,
          },
          select: { id: true },
        });

        const created = await tx.employee.create({
          data: scopedCreate<Prisma.EmployeeUncheckedCreateInput>({
            userId: user.id,
            role: dto.role,
            isOwner: false,
            hiredAt: dto.hiredAt ? parseDateOnly(dto.hiredAt) : null,
            bio: dto.bio ?? null,
            avatarUrl: dto.avatarUrl ?? null,
          }),
          select: EMPLOYEE_SELECT,
        });

        if (dto.branchIds && dto.branchIds.length > 0) {
          await tx.employeeBranch.createMany({
            data: dto.branchIds.map((branchId) =>
              scopedCreate<Prisma.EmployeeBranchUncheckedCreateInput>({
                employeeId: created.id,
                branchId,
              }),
            ),
          });
        }

        const row = await tx.employeeInvitation.create({
          data: scopedCreate<Prisma.EmployeeInvitationUncheckedCreateInput>({
            employeeId: created.id,
            tokenHash: invitation.tokenHash,
            expiresAt: invitation.expiresAt,
          }),
          select: { id: true },
        });

        return { employee: created, invitationId: row.id };
      })
      .catch((error: unknown) => {
        if (isUniqueViolation(error)) {
          throw new ConflictException(
            'Ese email ya tiene una cuenta en AgendApp',
          );
        }
        throw error;
      });

    return {
      employee: toEmployeeResponse(employee),
      activationUrl: this.invitations.buildActivationUrl(
        invitationId,
        invitation.secret,
      ),
      expiresAt: invitation.expiresAt,
    };
  }

  /**
   * Emite una invitación nueva y revoca la anterior: para cuando el link se
   * perdió o venció. Solo tiene sentido mientras el empleado no haya elegido
   * contraseña.
   */
  async resendInvitation(id: string): Promise<EmployeeInvitationResponseDto> {
    const employee = await this.findEmployeeOrFail(id);

    if (employee.user.passwordHash !== null) {
      throw new ConflictException(
        'El empleado ya activó su cuenta: si no puede entrar, tiene que ' +
          'recuperar la contraseña.',
      );
    }

    const invitation = await this.invitations.mint();

    const invitationId = await this.prisma.scoped.$transaction(async (tx) => {
      // El índice parcial de la base solo admite una invitación viva por
      // empleado: revocar la anterior no es prolijidad, es un requisito.
      await tx.employeeInvitation.updateMany({
        where: { employeeId: id, acceptedAt: null, revokedAt: null },
        data: { revokedAt: new Date() },
      });

      const row = await tx.employeeInvitation.create({
        data: scopedCreate<Prisma.EmployeeInvitationUncheckedCreateInput>({
          employeeId: id,
          tokenHash: invitation.tokenHash,
          expiresAt: invitation.expiresAt,
        }),
        select: { id: true },
      });

      return row.id;
    });

    return {
      employee: toEmployeeResponse(employee),
      activationUrl: this.invitations.buildActivationUrl(
        invitationId,
        invitation.secret,
      ),
      expiresAt: invitation.expiresAt,
    };
  }

  async findAll(query: ListEmployeesQueryDto): Promise<EmployeeResponseDto[]> {
    const employees = await this.prisma.scoped.employee.findMany({
      where: {
        ...(query.isActive === undefined ? {} : { isActive: query.isActive }),
        ...(query.role === undefined ? {} : { role: query.role }),
        ...(query.branchId === undefined
          ? {}
          : { branches: { some: { branchId: query.branchId } } }),
      },
      select: EMPLOYEE_SELECT,
      // El dueño primero; después, por apellido.
      orderBy: [
        { isOwner: 'desc' },
        { user: { lastName: 'asc' } },
        { user: { firstName: 'asc' } },
      ],
    });

    return employees.map(toEmployeeResponse);
  }

  async findOne(id: string): Promise<EmployeeDetailResponseDto> {
    const employee = await this.findEmployeeOrFail(id);

    return {
      ...toEmployeeResponse(employee),
      branchIds: await this.loadBranchIds(id),
    };
  }

  async update(
    id: string,
    dto: UpdateEmployeeDto,
  ): Promise<EmployeeResponseDto> {
    const current = await this.findEmployeeOrFail(id);

    if (current.isOwner && (dto.role !== undefined || dto.isActive === false)) {
      throw new ForbiddenException(
        'Al dueño del negocio no se le puede cambiar el rol ni desactivarlo',
      );
    }

    if (dto.isActive === false && id === this.tenantContext.getEmployeeId()) {
      throw new BadRequestException(
        'No podés desactivarte a vos mismo: pedíselo a otro administrador',
      );
    }

    const data = pickDefined<Prisma.EmployeeUpdateInput>({
      role: dto.role,
      isActive: dto.isActive,
      hiredAt:
        dto.hiredAt === undefined
          ? undefined
          : dto.hiredAt === null
            ? null
            : parseDateOnly(dto.hiredAt),
      bio: dto.bio,
      avatarUrl: dto.avatarUrl,
    });

    if (isEmpty(data)) {
      return toEmployeeResponse(current);
    }

    const updated = await this.prisma.scoped.employee.update({
      where: { id, deletedAt: null },
      data,
      select: EMPLOYEE_SELECT,
    });

    return toEmployeeResponse(updated);
  }

  /**
   * Baja lógica del empleado. El `User` queda: es una cuenta de persona, no del
   * negocio, y borrarla rompería el historial de turnos que ya atendió.
   */
  async remove(id: string): Promise<void> {
    const employee = await this.findEmployeeOrFail(id);

    if (employee.isOwner) {
      throw new ForbiddenException(
        'No se puede dar de baja al dueño del negocio',
      );
    }

    if (id === this.tenantContext.getEmployeeId()) {
      throw new BadRequestException('No podés darte de baja a vos mismo');
    }

    await this.prisma.scoped.employee.delete({ where: { id } });
  }

  /**
   * Reemplaza el set de sucursales del empleado. El horario que tuviera en una
   * sucursal que se le saca se borra junto con ella: un turno asignado en un
   * lugar donde ya no trabaja no significa nada.
   */
  async setBranches(
    id: string,
    dto: SetEmployeeBranchesDto,
  ): Promise<string[]> {
    await this.findEmployeeOrFail(id);
    await this.assertBranchesExist(dto.branchIds);

    await this.prisma.scoped.$transaction(async (tx) => {
      await tx.employeeBranch.deleteMany({ where: { employeeId: id } });

      if (dto.branchIds.length > 0) {
        await tx.employeeBranch.createMany({
          data: dto.branchIds.map((branchId) =>
            scopedCreate<Prisma.EmployeeBranchUncheckedCreateInput>({
              employeeId: id,
              branchId,
            }),
          ),
        });
      }

      await tx.employeeSchedule.deleteMany({
        where: {
          employeeId: id,
          ...(dto.branchIds.length > 0
            ? { branchId: { notIn: dto.branchIds } }
            : {}),
        },
      });
    });

    return this.loadBranchIds(id);
  }

  async findSchedules(id: string): Promise<EmployeeShiftResponseDto[]> {
    await this.findEmployeeOrFail(id);

    return this.loadSchedules(id);
  }

  /**
   * Reemplaza el horario completo del empleado, en todas sus sucursales.
   *
   * Es un set completo y no un alta de a un tramo porque las reglas (que no se
   * pisen entre sí) se validan sobre la semana entera: revisar un tramo contra
   * los que ya están en la base daría el mismo trabajo con la mitad de las
   * garantías.
   */
  async setSchedules(
    id: string,
    dto: SetEmployeeSchedulesDto,
  ): Promise<EmployeeShiftResponseDto[]> {
    await this.findEmployeeOrFail(id);

    const assigned = new Set(await this.loadBranchIds(id));
    const rows = this.toShiftRows(dto.shifts, assigned);

    await this.prisma.scoped.$transaction(async (tx) => {
      await tx.employeeSchedule.deleteMany({ where: { employeeId: id } });

      if (rows.length > 0) {
        await tx.employeeSchedule.createMany({
          data: rows.map((row) =>
            scopedCreate<Prisma.EmployeeScheduleUncheckedCreateInput>({
              ...row,
              employeeId: id,
            }),
          ),
        });
      }
    });

    return this.loadSchedules(id);
  }

  async findTimeOff(
    id: string,
    query: ListTimeOffQueryDto,
  ): Promise<TimeOffResponseDto[]> {
    await this.findEmployeeOrFail(id);

    const from = query.from === undefined ? undefined : new Date(query.from);
    const to = query.to === undefined ? undefined : new Date(query.to);

    const rows = await this.prisma.scoped.employeeTimeOff.findMany({
      where: {
        employeeId: id,
        // Se pide "las que tocan el rango", no "las que caen adentro": unas
        // vacaciones de enero a marzo tienen que aparecer al mirar febrero.
        ...(to === undefined ? {} : { startsAt: { lte: to } }),
        ...(from === undefined ? {} : { endsAt: { gte: from } }),
      },
      select: TIME_OFF_SELECT,
      orderBy: { startsAt: 'asc' },
    });

    return rows;
  }

  async createTimeOff(
    id: string,
    dto: CreateTimeOffDto,
  ): Promise<TimeOffResponseDto> {
    await this.findEmployeeOrFail(id);

    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);

    if (endsAt.getTime() <= startsAt.getTime()) {
      throw new BadRequestException(
        'La ausencia tiene que terminar después de empezar',
      );
    }

    if (dto.branchId) {
      await this.assertBranchesExist([dto.branchId]);
    }

    return this.prisma.scoped.employeeTimeOff.create({
      data: scopedCreate<Prisma.EmployeeTimeOffUncheckedCreateInput>({
        employeeId: id,
        branchId: dto.branchId ?? null,
        startsAt,
        endsAt,
        reason: dto.reason ?? null,
      }),
      select: TIME_OFF_SELECT,
    });
  }

  async removeTimeOff(id: string, timeOffId: string): Promise<void> {
    await this.findEmployeeOrFail(id);

    const existing = await this.prisma.scoped.employeeTimeOff.findFirst({
      where: { id: timeOffId, employeeId: id },
      select: { id: true },
    });

    if (!existing) {
      throw new NotFoundException('La ausencia no existe para este empleado');
    }

    await this.prisma.scoped.employeeTimeOff.delete({
      where: { id: timeOffId },
    });
  }

  /**
   * El plan sale del `Tenant`, exento del scoping, así que acá hace falta el
   * tenantId explícito. **El dueño cuenta**: un plan de 3 empleados son el
   * dueño y dos más.
   *
   * Los invitados que todavía no aceptaron también cuentan: la fila ya existe y
   * el lugar está tomado.
   */
  private async assertEmployeeQuotaAvailable(): Promise<void> {
    const tenantId = this.requireTenantId('invite');

    const tenant = await this.prisma.scoped.tenant.findFirst({
      where: { id: tenantId },
      select: { plan: { select: { name: true, maxEmployees: true } } },
    });

    if (!tenant) {
      throw new NotFoundException('El negocio no existe o fue dado de baja');
    }

    const { maxEmployees, name } = tenant.plan;

    if (maxEmployees === null) {
      return;
    }

    const current = await this.prisma.scoped.employee.count();

    if (current >= maxEmployees) {
      throw new ForbiddenException(
        `El plan ${name} permite hasta ${maxEmployees} ` +
          `${maxEmployees === 1 ? 'empleado' : 'empleados'} (el dueño incluido). ` +
          'Para sumar más hay que cambiar de plan.',
      );
    }
  }

  /**
   * El email es único a nivel sistema, no por negocio: hoy una persona
   * pertenece a un solo tenant. Se consulta con el cliente base porque `User`
   * está exento del scoping y la cuenta podría ser de otro negocio.
   */
  private async assertEmailAvailable(email: string): Promise<void> {
    const existing = await this.prisma.user.findFirst({
      where: { email, deletedAt: null },
      select: { id: true },
    });

    if (existing) {
      throw new ConflictException('Ese email ya tiene una cuenta en AgendApp');
    }
  }

  /** Que las sucursales existan Y sean de este negocio (la extension filtra). */
  private async assertBranchesExist(branchIds: string[]): Promise<void> {
    if (branchIds.length === 0) {
      return;
    }

    const found = await this.prisma.scoped.branch.findMany({
      where: { id: { in: branchIds } },
      select: { id: true },
    });

    if (found.length !== branchIds.length) {
      const existing = new Set(found.map((branch) => branch.id));
      const missing = branchIds.filter((id) => !existing.has(id));

      throw new BadRequestException(
        `Estas sucursales no existen en tu negocio: ${missing.join(', ')}`,
      );
    }
  }

  private async findEmployeeOrFail(id: string): Promise<EmployeeRow> {
    const employee = await this.prisma.scoped.employee.findFirst({
      where: { id },
      select: EMPLOYEE_SELECT,
    });

    if (!employee) {
      throw new NotFoundException('El empleado no existe');
    }

    return employee;
  }

  private async loadBranchIds(employeeId: string): Promise<string[]> {
    const rows = await this.prisma.scoped.employeeBranch.findMany({
      where: { employeeId },
      select: { branchId: true },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((row) => row.branchId);
  }

  private async loadSchedules(
    employeeId: string,
  ): Promise<EmployeeShiftResponseDto[]> {
    const rows = await this.prisma.scoped.employeeSchedule.findMany({
      where: { employeeId },
      select: SHIFT_SELECT,
      orderBy: [{ dayOfWeek: 'asc' }, { startsAt: 'asc' }],
    });

    return rows.map((row) => ({
      id: row.id,
      branchId: row.branchId,
      dayOfWeek: row.dayOfWeek,
      startsAt: dateToTimeOfDay(row.startsAt),
      endsAt: dateToTimeOfDay(row.endsAt),
    }));
  }

  /**
   * Valida los tramos y los pasa a filas.
   *
   * Dos reglas, las dos con la misma raíz — que el horario describa algo que
   * pueda pasar en el mundo real:
   *
   * 1. El tramo tiene que ser de una sucursal donde el empleado trabaja.
   * 2. Dos tramos del mismo día no se pueden pisar, **ni siquiera en sucursales
   *    distintas**: nadie atiende en dos lugares a la vez.
   */
  private toShiftRows(
    shifts: EmployeeShiftDto[],
    assignedBranchIds: Set<string>,
  ): {
    branchId: string;
    dayOfWeek: number;
    startsAt: Date;
    endsAt: Date;
  }[] {
    const byDay = new Map<number, { from: number; to: number }[]>();

    return shifts.map((shift) => {
      if (!assignedBranchIds.has(shift.branchId)) {
        throw new BadRequestException(
          `El empleado no trabaja en la sucursal ${shift.branchId}: ` +
            'asignásela primero con PUT /employees/:id/branches',
        );
      }

      const from = timeOfDayToMinutes(shift.startsAt);
      const to = timeOfDayToMinutes(shift.endsAt);

      if (to <= from) {
        throw new BadRequestException(
          `El tramo ${shift.startsAt}–${shift.endsAt} no termina después de empezar. ` +
            'Los horarios que cruzan la medianoche todavía no están soportados.',
        );
      }

      const sameDay = byDay.get(shift.dayOfWeek) ?? [];

      if (sameDay.some((other) => from < other.to && to > other.from)) {
        throw new BadRequestException(
          `El día ${shift.dayOfWeek} tiene tramos que se pisan: ` +
            'un empleado no puede estar en dos lugares a la vez',
        );
      }

      sameDay.push({ from, to });
      byDay.set(shift.dayOfWeek, sameDay);

      return {
        branchId: shift.branchId,
        dayOfWeek: shift.dayOfWeek,
        startsAt: timeOfDayToDate(shift.startsAt),
        endsAt: timeOfDayToDate(shift.endsAt),
      };
    });
  }

  private requireTenantId(operation: string): string {
    const tenantId = this.tenantContext.getTenantId();

    if (!tenantId) {
      throw new TenantContextMissingError('Tenant', operation);
    }

    return tenantId;
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/**
 * Arma el DTO campo por campo a propósito: el `select` trae `passwordHash`
 * para derivar el estado, y un spread lo mandaría derecho a la respuesta.
 */
function toEmployeeResponse(row: EmployeeRow): EmployeeResponseDto {
  return {
    id: row.id,
    role: row.role,
    isOwner: row.isOwner,
    isActive: row.isActive,
    status:
      row.user.passwordHash === null
        ? EmployeeStatus.PENDING
        : EmployeeStatus.ACTIVE,
    hiredAt: row.hiredAt === null ? null : dateToDateOnly(row.hiredAt),
    bio: row.bio,
    avatarUrl: row.avatarUrl,
    user: {
      id: row.user.id,
      email: row.user.email,
      firstName: row.user.firstName,
      lastName: row.user.lastName,
      phone: row.user.phone,
    },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
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
