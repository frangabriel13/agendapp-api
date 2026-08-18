import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { scopedCreate } from '../../prisma/extensions';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  CreateServiceCategoryDto,
  ServiceCategoryResponseDto,
  UpdateServiceCategoryDto,
} from './dto/service-category.dto';

const CATEGORY_SELECT = {
  id: true,
  name: true,
  displayOrder: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ServiceCategorySelect;

/**
 * Categorías de servicios: agrupan el catálogo para mostrarlo ordenado.
 *
 * Son deliberadamente livianas — nombre y orden, nada más. La categoría no
 * define precio ni duración: eso vive en cada servicio.
 */
@Injectable()
export class ServiceCategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    dto: CreateServiceCategoryDto,
  ): Promise<ServiceCategoryResponseDto> {
    try {
      return await this.prisma.scoped.serviceCategory.create({
        data: scopedCreate<Prisma.ServiceCategoryUncheckedCreateInput>({
          name: dto.name,
          displayOrder: dto.displayOrder ?? 0,
        }),
        select: CATEGORY_SELECT,
      });
    } catch (error) {
      throw duplicateNameOr(error);
    }
  }

  async findAll(): Promise<ServiceCategoryResponseDto[]> {
    return this.prisma.scoped.serviceCategory.findMany({
      select: CATEGORY_SELECT,
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async findOne(id: string): Promise<ServiceCategoryResponseDto> {
    return this.findCategoryOrFail(id);
  }

  async update(
    id: string,
    dto: UpdateServiceCategoryDto,
  ): Promise<ServiceCategoryResponseDto> {
    const current = await this.findCategoryOrFail(id);

    const data = pickDefined<Prisma.ServiceCategoryUpdateInput>({
      name: dto.name,
      displayOrder: dto.displayOrder,
    });

    if (isEmpty(data)) {
      return current;
    }

    try {
      return await this.prisma.scoped.serviceCategory.update({
        where: { id, deletedAt: null },
        data,
        select: CATEGORY_SELECT,
      });
    } catch (error) {
      throw duplicateNameOr(error);
    }
  }

  /**
   * Baja lógica. Los servicios de la categoría NO se borran: quedan sin
   * categoría (`categoryId = null`), que es lo que el `ON DELETE SET NULL` del
   * schema haría si el borrado fuera físico. Como acá es lógico, la FK nunca se
   * dispara y hay que hacerlo a mano — si no, los servicios quedarían apuntando
   * a una categoría que ya no aparece en ninguna lista.
   */
  async remove(id: string): Promise<void> {
    await this.findCategoryOrFail(id);

    await this.prisma.scoped.$transaction(async (tx) => {
      await tx.service.updateMany({
        where: { categoryId: id },
        data: { categoryId: null },
      });
      await tx.serviceCategory.delete({ where: { id } });
    });
  }

  /** Toda operación sobre una categoría ajena o inexistente muere acá. */
  private async findCategoryOrFail(
    id: string,
  ): Promise<ServiceCategoryResponseDto> {
    const category = await this.prisma.scoped.serviceCategory.findFirst({
      where: { id },
      select: CATEGORY_SELECT,
    });

    if (!category) {
      throw new NotFoundException('La categoría no existe');
    }

    return category;
  }
}

/**
 * El único UNIQUE que puede romper una categoría es el índice parcial
 * `(tenant_id, lower(name))` sobre las no borradas.
 */
function duplicateNameOr(error: unknown): unknown {
  const isUniqueViolation =
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002';

  return isUniqueViolation
    ? new ConflictException('Ya tenés una categoría con ese nombre')
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
