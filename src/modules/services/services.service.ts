import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { scopedCreate } from '../../prisma/extensions';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  ServiceEmployeeDto,
  ServiceEmployeeResponseDto,
  SetServiceEmployeesDto,
} from './dto/employee-service.dto';
import type {
  ServiceResourceResponseDto,
  SetServiceResourcesDto,
} from './dto/service-resource.dto';
import type {
  CreateServiceDto,
  ListServicesQueryDto,
  ServiceResponseDto,
  UpdateServiceDto,
} from './dto/service.dto';

const SERVICE_SELECT = {
  id: true,
  name: true,
  description: true,
  durationMinutes: true,
  priceCents: true,
  depositAmountCents: true,
  bufferAfterMinutes: true,
  color: true,
  isActive: true,
  publiclyBookable: true,
  createdAt: true,
  updatedAt: true,
  category: { select: { id: true, name: true } },
} satisfies Prisma.ServiceSelect;

/**
 * Catálogo de servicios: qué vende el negocio, cuánto dura y cuánto sale.
 *
 * La duración y el buffer no son decorativos — la Fase 5 arma los slots de la
 * agenda con esos dos números. Un servicio mal cargado acá se traduce en turnos
 * que se pisan o en huecos que nadie puede reservar.
 *
 * El precio va en centavos (`Int`), como toda la plata del proyecto. Nunca
 * `Decimal` ni `Float`.
 */
@Injectable()
export class ServicesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateServiceDto): Promise<ServiceResponseDto> {
    const categoryId = dto.categoryId ?? null;

    if (categoryId !== null) {
      await this.assertCategoryExists(categoryId);
    }

    const priceCents = dto.priceCents;
    const depositAmountCents = dto.depositAmountCents ?? null;
    assertDepositFitsPrice(depositAmountCents, priceCents);

    return this.prisma.scoped.service.create({
      data: scopedCreate<Prisma.ServiceUncheckedCreateInput>({
        name: dto.name,
        description: dto.description ?? null,
        categoryId,
        durationMinutes: dto.durationMinutes,
        priceCents,
        depositAmountCents,
        bufferAfterMinutes: dto.bufferAfterMinutes ?? 0,
        color: dto.color ?? null,
      }),
      select: SERVICE_SELECT,
    });
  }

  async findAll(query: ListServicesQueryDto): Promise<ServiceResponseDto[]> {
    return this.prisma.scoped.service.findMany({
      where: pickDefined<Prisma.ServiceWhereInput>({
        isActive: query.isActive,
        categoryId: query.categoryId,
      }),
      select: SERVICE_SELECT,
      orderBy: [{ name: 'asc' }],
    });
  }

  async findOne(id: string): Promise<ServiceResponseDto> {
    return this.findServiceOrFail(id);
  }

  async update(id: string, dto: UpdateServiceDto): Promise<ServiceResponseDto> {
    const current = await this.findServiceOrFail(id);

    if (dto.categoryId !== undefined && dto.categoryId !== null) {
      await this.assertCategoryExists(dto.categoryId);
    }

    // El CHECK de la base compara los dos valores *finales*, así que el que no
    // viene en el PATCH es el que ya estaba. Validarlo acá es para dar un error
    // legible en vez de un 500 de Postgres.
    assertDepositFitsPrice(
      dto.depositAmountCents === undefined
        ? current.depositAmountCents
        : dto.depositAmountCents,
      dto.priceCents ?? current.priceCents,
    );

    const data = pickDefined<Prisma.ServiceUncheckedUpdateInput>({
      name: dto.name,
      description: dto.description,
      categoryId: dto.categoryId,
      durationMinutes: dto.durationMinutes,
      priceCents: dto.priceCents,
      depositAmountCents: dto.depositAmountCents,
      bufferAfterMinutes: dto.bufferAfterMinutes,
      color: dto.color,
      isActive: dto.isActive,
      publiclyBookable: dto.publiclyBookable,
    });

    if (isEmpty(data)) {
      return current;
    }

    return this.prisma.scoped.service.update({
      where: { id, deletedAt: null },
      data,
      select: SERVICE_SELECT,
    });
  }

  /**
   * Baja lógica. Las asignaciones a empleados quedan en la base pero dejan de
   * ser alcanzables, porque solo se llega a ellas a través del servicio — mismo
   * criterio que los horarios de una sucursal dada de baja.
   */
  async remove(id: string): Promise<void> {
    await this.findServiceOrFail(id);
    await this.prisma.scoped.service.delete({ where: { id } });
  }

  async findEmployees(
    serviceId: string,
  ): Promise<ServiceEmployeeResponseDto[]> {
    await this.findServiceOrFail(serviceId);

    return this.loadEmployees(serviceId);
  }

  /**
   * Reemplaza el set completo de "quién presta este servicio y dónde".
   *
   * Es un PUT y no un alta de a uno porque la lista se valida entera: cada par
   * (empleado, sucursal) tiene que existir en `employee_branches`. Sin ese
   * chequeo se podría asignar a alguien en una sucursal donde no trabaja, y la
   * Fase 5 ofrecería un turno que nadie puede atender.
   */
  async setEmployees(
    serviceId: string,
    dto: SetServiceEmployeesDto,
  ): Promise<ServiceEmployeeResponseDto[]> {
    await this.findServiceOrFail(serviceId);

    const assignments = dto.assignments;
    assertNoDuplicates(assignments);
    await this.assertEmployeesWorkAtBranches(assignments);

    await this.prisma.scoped.$transaction(async (tx) => {
      await tx.employeeService.deleteMany({ where: { serviceId } });

      if (assignments.length > 0) {
        await tx.employeeService.createMany({
          data: assignments.map((assignment) =>
            scopedCreate<Prisma.EmployeeServiceUncheckedCreateInput>({
              serviceId,
              employeeId: assignment.employeeId,
              branchId: assignment.branchId,
            }),
          ),
        });
      }
    });

    return this.loadEmployees(serviceId);
  }

  async findResources(
    serviceId: string,
  ): Promise<ServiceResourceResponseDto[]> {
    await this.findServiceOrFail(serviceId);

    return this.loadResources(serviceId);
  }

  /**
   * Reemplaza qué recursos necesita el servicio (una camilla, una sala).
   *
   * No se valida contra las sucursales donde se presta el servicio: un recurso
   * de Centro y una profesional que trabaja en Palermo no son un error de
   * carga, simplemente no se cruzan. Esa intersección la resuelve la Fase 5 al
   * calcular disponibilidad, que es donde tiene sentido.
   */
  async setResources(
    serviceId: string,
    dto: SetServiceResourcesDto,
  ): Promise<ServiceResourceResponseDto[]> {
    await this.findServiceOrFail(serviceId);

    const resourceIds = dto.resourceIds;
    assertNoRepeatedIds(resourceIds);
    await this.assertResourcesExist(resourceIds);

    await this.prisma.scoped.$transaction(async (tx) => {
      await tx.serviceResource.deleteMany({ where: { serviceId } });

      if (resourceIds.length > 0) {
        await tx.serviceResource.createMany({
          data: resourceIds.map((resourceId) =>
            scopedCreate<Prisma.ServiceResourceUncheckedCreateInput>({
              serviceId,
              resourceId,
            }),
          ),
        });
      }
    });

    return this.loadResources(serviceId);
  }

  /** Sin chequear el servicio: para cuando el caller ya lo validó. */
  private async loadResources(
    serviceId: string,
  ): Promise<ServiceResourceResponseDto[]> {
    const rows = await this.prisma.scoped.serviceResource.findMany({
      where: { serviceId },
      select: {
        resourceId: true,
        resource: {
          select: { name: true, branch: { select: { id: true, name: true } } },
        },
      },
      orderBy: [{ resource: { name: 'asc' } }],
    });

    return rows.map((row) => ({
      resourceId: row.resourceId,
      resourceName: row.resource.name,
      branchId: row.resource.branch.id,
      branchName: row.resource.branch.name,
    }));
  }

  /** Que los recursos existan Y sean de este negocio (la extension filtra). */
  private async assertResourcesExist(resourceIds: string[]): Promise<void> {
    if (resourceIds.length === 0) {
      return;
    }

    const found = await this.prisma.scoped.resource.findMany({
      where: { id: { in: resourceIds } },
      select: { id: true },
    });

    if (found.length !== resourceIds.length) {
      const existing = new Set(found.map((resource) => resource.id));
      const missing = resourceIds.filter((id) => !existing.has(id));

      throw new BadRequestException(
        `Estos recursos no existen en tu negocio: ${missing.join(', ')}`,
      );
    }
  }

  /** Sin chequear el servicio: para cuando el caller ya lo validó. */
  private async loadEmployees(
    serviceId: string,
  ): Promise<ServiceEmployeeResponseDto[]> {
    const rows = await this.prisma.scoped.employeeService.findMany({
      where: { serviceId },
      select: {
        employeeId: true,
        branchId: true,
        employee: {
          select: { user: { select: { firstName: true, lastName: true } } },
        },
        branch: { select: { name: true } },
      },
      orderBy: [{ branch: { name: 'asc' } }],
    });

    return rows.map((row) => ({
      employeeId: row.employeeId,
      employeeName: `${row.employee.user.firstName} ${row.employee.user.lastName}`,
      branchId: row.branchId,
      branchName: row.branch.name,
    }));
  }

  /**
   * Que cada par exista en `employee_branches`. De paso cubre que el empleado y
   * la sucursal existan y sean de este negocio: si alguno es de otro tenant, la
   * extension lo filtra y el par simplemente no aparece.
   */
  private async assertEmployeesWorkAtBranches(
    assignments: ServiceEmployeeDto[],
  ): Promise<void> {
    if (assignments.length === 0) {
      return;
    }

    const employeeIds = [...new Set(assignments.map((a) => a.employeeId))];
    const branchIds = [...new Set(assignments.map((a) => a.branchId))];

    const links = await this.prisma.scoped.employeeBranch.findMany({
      where: {
        employeeId: { in: employeeIds },
        branchId: { in: branchIds },
      },
      select: { employeeId: true, branchId: true },
    });

    const valid = new Set(links.map((link) => pairKey(link)));
    const invalid = assignments.filter(
      (assignment) => !valid.has(pairKey(assignment)),
    );

    if (invalid.length > 0) {
      const detail = invalid
        .map((a) => `${a.employeeId} en ${a.branchId}`)
        .join('; ');

      throw new BadRequestException(
        'Estos empleados no trabajan en la sucursal que se les asignó ' +
          `(o no existen en tu negocio): ${detail}`,
      );
    }
  }

  /** Que la categoría exista Y sea de este negocio (la extension filtra). */
  private async assertCategoryExists(categoryId: string): Promise<void> {
    const category = await this.prisma.scoped.serviceCategory.findFirst({
      where: { id: categoryId },
      select: { id: true },
    });

    if (!category) {
      throw new BadRequestException(
        `La categoría ${categoryId} no existe en tu negocio`,
      );
    }
  }

  /** Toda operación sobre un servicio ajeno o inexistente muere acá. */
  private async findServiceOrFail(id: string): Promise<ServiceResponseDto> {
    const service = await this.prisma.scoped.service.findFirst({
      where: { id },
      select: SERVICE_SELECT,
    });

    if (!service) {
      throw new NotFoundException('El servicio no existe');
    }

    return service;
  }
}

function pairKey(pair: { employeeId: string; branchId: string }): string {
  return `${pair.employeeId}:${pair.branchId}`;
}

/**
 * Un par repetido rompería el UNIQUE de la tabla con un 500 poco explicativo.
 * Mejor rechazarlo con un mensaje que diga cuál.
 */
function assertNoDuplicates(assignments: ServiceEmployeeDto[]): void {
  const seen = new Set<string>();
  const repeated = new Set<string>();

  for (const assignment of assignments) {
    const key = pairKey(assignment);

    if (seen.has(key)) {
      repeated.add(key);
    }

    seen.add(key);
  }

  if (repeated.size > 0) {
    throw new BadRequestException(
      `Estas asignaciones vienen repetidas: ${[...repeated].join('; ')}`,
    );
  }
}

/** Mismo motivo que `assertNoDuplicates`, pero para una lista de ids sueltos. */
function assertNoRepeatedIds(ids: string[]): void {
  const repeated = ids.filter((id, index) => ids.indexOf(id) !== index);

  if (repeated.length > 0) {
    throw new BadRequestException(
      `Estos recursos vienen repetidos: ${[...new Set(repeated)].join(', ')}`,
    );
  }
}

/** Cobrar de seña más que el total no tiene sentido. */
function assertDepositFitsPrice(
  depositAmountCents: number | null,
  priceCents: number,
): void {
  if (depositAmountCents !== null && depositAmountCents > priceCents) {
    throw new BadRequestException(
      'La seña no puede ser mayor que el precio del servicio',
    );
  }
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
