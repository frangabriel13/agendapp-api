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
import { scopedCreate } from '../../prisma/extensions';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  CreateResourceDto,
  ListResourcesQueryDto,
  ResourceResponseDto,
  UpdateResourceDto,
} from './dto/resource.dto';

const RESOURCE_SELECT = {
  id: true,
  name: true,
  description: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  branch: { select: { id: true, name: true } },
} satisfies Prisma.ResourceSelect;

/**
 * Recursos: camillas, sillones, salas. Lo que un turno ocupa además del
 * profesional.
 *
 * Cuelgan de una sucursal y no del negocio porque son objetos físicos: una
 * camilla está en un lugar. La Fase 5 los usa para no reservar dos veces el
 * mismo recurso en horarios que se pisan.
 *
 * Es una feature de plan: `plan.includesResources` la habilita.
 */
@Injectable()
export class ResourcesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async create(dto: CreateResourceDto): Promise<ResourceResponseDto> {
    await this.assertPlanIncludesResources();
    await this.assertBranchExists(dto.branchId);

    try {
      return await this.prisma.scoped.resource.create({
        data: scopedCreate<Prisma.ResourceUncheckedCreateInput>({
          name: dto.name,
          branchId: dto.branchId,
          description: dto.description ?? null,
        }),
        select: RESOURCE_SELECT,
      });
    } catch (error) {
      throw duplicateNameOr(error);
    }
  }

  async findAll(query: ListResourcesQueryDto): Promise<ResourceResponseDto[]> {
    return this.prisma.scoped.resource.findMany({
      where: pickDefined<Prisma.ResourceWhereInput>({
        branchId: query.branchId,
        isActive: query.isActive,
      }),
      select: RESOURCE_SELECT,
      orderBy: [{ branch: { name: 'asc' } }, { name: 'asc' }],
    });
  }

  async findOne(id: string): Promise<ResourceResponseDto> {
    return this.findResourceOrFail(id);
  }

  async update(
    id: string,
    dto: UpdateResourceDto,
  ): Promise<ResourceResponseDto> {
    const current = await this.findResourceOrFail(id);

    const data = pickDefined<Prisma.ResourceUpdateInput>({
      name: dto.name,
      description: dto.description,
      isActive: dto.isActive,
    });

    if (isEmpty(data)) {
      return current;
    }

    try {
      return await this.prisma.scoped.resource.update({
        where: { id, deletedAt: null },
        data,
        select: RESOURCE_SELECT,
      });
    } catch (error) {
      throw duplicateNameOr(error);
    }
  }

  /**
   * Baja lógica. El vínculo con los servicios que lo requerían queda en la base
   * pero deja de ser alcanzable — mismo criterio que en el resto del catálogo.
   */
  async remove(id: string): Promise<void> {
    await this.findResourceOrFail(id);
    await this.prisma.scoped.resource.delete({ where: { id } });
  }

  /**
   * A diferencia del cupo de sucursales, esto es un sí/no del plan, así que no
   * hace falta contar ni bloquear filas: alcanza con leer la bandera.
   */
  private async assertPlanIncludesResources(): Promise<void> {
    const tenantId = this.tenantContext.getTenantId();

    if (!tenantId) {
      throw new TenantContextMissingError('Tenant', 'create resource');
    }

    const tenant = await this.prisma.scoped.tenant.findFirst({
      where: { id: tenantId },
      select: { plan: { select: { name: true, includesResources: true } } },
    });

    if (!tenant) {
      throw new NotFoundException('El negocio no existe o fue dado de baja');
    }

    if (!tenant.plan.includesResources) {
      throw new ForbiddenException(
        `El plan ${tenant.plan.name} no incluye recursos (camillas, salas, ` +
          'sillones). Para usarlos hay que cambiar de plan.',
      );
    }
  }

  /** Que la sucursal exista Y sea de este negocio (la extension filtra). */
  private async assertBranchExists(branchId: string): Promise<void> {
    const branch = await this.prisma.scoped.branch.findFirst({
      where: { id: branchId },
      select: { id: true },
    });

    if (!branch) {
      throw new BadRequestException(
        `La sucursal ${branchId} no existe en tu negocio`,
      );
    }
  }

  /** Toda operación sobre un recurso ajeno o inexistente muere acá. */
  private async findResourceOrFail(id: string): Promise<ResourceResponseDto> {
    const resource = await this.prisma.scoped.resource.findFirst({
      where: { id },
      select: RESOURCE_SELECT,
    });

    if (!resource) {
      throw new NotFoundException('El recurso no existe');
    }

    return resource;
  }
}

/**
 * El único UNIQUE que puede romper un recurso es el índice parcial
 * `(branch_id, lower(name))` sobre los no borrados.
 */
function duplicateNameOr(error: unknown): unknown {
  const isUniqueViolation =
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002';

  return isUniqueViolation
    ? new ConflictException('Esa sucursal ya tiene un recurso con ese nombre')
    : error;
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
