import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantContextMissingError } from '../../common/errors/tenant-context-missing.error';
import { TenantContextService } from '../../common/tenant-context';
import { parseDateOnly } from '../../common/utils/date-only.util';
import {
  MINUTES_PER_DAY,
  timeColumnToMinutes,
  zonedDayOfWeek,
  zonedWallTimeToUtc,
} from '../../common/utils/timezone.util';
import { PrismaService } from '../../prisma/prisma.service';
import {
  BLOCKING_STATUSES,
  intersectIntervals,
  mergeIntervals,
  splitIntoSlots,
  subtractIntervals,
  type Interval,
} from './availability';
import type {
  AvailabilityQueryDto,
  AvailabilityResponseDto,
  AvailabilitySlotDto,
  AvailableEmployeeDto,
} from './dto/availability.dto';

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
    const service = await this.findServiceOrFail(query.serviceId);
    await this.assertBranchExists(query.branchId);

    const slotMinutes = service.durationMinutes + service.bufferAfterMinutes;
    const dayStart = zonedWallTimeToUtc(query.date, 0, timezone);
    const dayEnd = zonedWallTimeToUtc(query.date, MINUTES_PER_DAY, timezone);

    const base: Omit<AvailabilityResponseDto, 'branchClosed' | 'slots'> = {
      date: query.date,
      timezone,
      durationMinutes: service.durationMinutes,
      bufferAfterMinutes: service.bufferAfterMinutes,
    };

    const branchWindow = await this.branchWindow(
      query.branchId,
      query.date,
      timezone,
    );

    if (!branchWindow) {
      return { ...base, branchClosed: true, slots: [] };
    }

    const branchOpen = [toInterval(branchWindow, query.date, timezone)];
    const employees = await this.employeesForService(query);

    if (employees.length === 0) {
      return { ...base, branchClosed: false, slots: [] };
    }

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
      this.resourceBusyIntervals(
        query.serviceId,
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

    return { ...base, branchClosed: false, slots };
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
  private async employeesForService(
    query: AvailabilityQueryDto,
  ): Promise<AvailableEmployeeDto[]> {
    const assignments = await this.prisma.scoped.employeeService.findMany({
      where: {
        serviceId: query.serviceId,
        branchId: query.branchId,
        ...(query.employeeId === undefined
          ? {}
          : { employeeId: query.employeeId }),
        employee: { isActive: true, deletedAt: null },
      },
      select: {
        employeeId: true,
        employee: {
          select: { user: { select: { firstName: true, lastName: true } } },
        },
      },
    });

    return assignments.map((assignment) => ({
      employeeId: assignment.employeeId,
      employeeName: `${assignment.employee.user.firstName} ${assignment.employee.user.lastName}`,
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
  ): Promise<Map<string, Interval[]>> {
    const appointments = await this.prisma.scoped.appointment.findMany({
      where: {
        employeeId: { in: employeeIds },
        status: { in: [...BLOCKING_STATUSES] },
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
    serviceId: string,
    branchId: string,
    dayStart: Date,
    dayEnd: Date,
  ): Promise<Interval[]> {
    const required = await this.prisma.scoped.serviceResource.findMany({
      where: {
        serviceId,
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

  private async findServiceOrFail(
    serviceId: string,
  ): Promise<{ durationMinutes: number; bufferAfterMinutes: number }> {
    const service = await this.prisma.scoped.service.findFirst({
      where: { id: serviceId },
      select: {
        durationMinutes: true,
        bufferAfterMinutes: true,
        isActive: true,
      },
    });

    if (!service) {
      throw new NotFoundException('El servicio no existe');
    }

    if (!service.isActive) {
      throw new BadRequestException(
        'El servicio está desactivado: no se puede reservar',
      );
    }

    return service;
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
