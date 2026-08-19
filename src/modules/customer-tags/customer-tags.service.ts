import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { scopedCreate } from '../../prisma/extensions';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  CreateCustomerTagDto,
  CustomerTagResponseDto,
  UpdateCustomerTagDto,
} from './dto/customer-tag.dto';

/**
 * El conteo se filtra por clientes vivos a mano: la extension de soft-delete
 * solo toca el `where` de primer nivel, no los de las relaciones anidadas. Sin
 * esto, una etiqueta mostraría "42 clientes" incluyendo gente dada de baja.
 */
const TAG_SELECT = {
  id: true,
  name: true,
  color: true,
  createdAt: true,
  updatedAt: true,
  _count: {
    select: { assignments: { where: { customer: { deletedAt: null } } } },
  },
} satisfies Prisma.CustomerTagSelect;

type TagRow = Prisma.CustomerTagGetPayload<{ select: typeof TAG_SELECT }>;

/**
 * Etiquetas de clientes: "VIP", "Debe seña", "Alérgica al amoníaco".
 *
 * Son del negocio, no de la sucursal: una clienta VIP lo es en todas.
 */
@Injectable()
export class CustomerTagsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateCustomerTagDto): Promise<CustomerTagResponseDto> {
    try {
      const tag = await this.prisma.scoped.customerTag.create({
        data: scopedCreate<Prisma.CustomerTagUncheckedCreateInput>({
          name: dto.name,
          color: dto.color ?? null,
        }),
        select: TAG_SELECT,
      });

      return toResponse(tag);
    } catch (error) {
      throw duplicateNameOr(error);
    }
  }

  async findAll(): Promise<CustomerTagResponseDto[]> {
    const tags = await this.prisma.scoped.customerTag.findMany({
      select: TAG_SELECT,
      orderBy: { name: 'asc' },
    });

    return tags.map(toResponse);
  }

  async findOne(id: string): Promise<CustomerTagResponseDto> {
    return toResponse(await this.findTagOrFail(id));
  }

  async update(
    id: string,
    dto: UpdateCustomerTagDto,
  ): Promise<CustomerTagResponseDto> {
    const current = await this.findTagOrFail(id);

    const data = pickDefined<Prisma.CustomerTagUpdateInput>({
      name: dto.name,
      color: dto.color,
    });

    if (isEmpty(data)) {
      return toResponse(current);
    }

    try {
      const tag = await this.prisma.scoped.customerTag.update({
        where: { id, deletedAt: null },
        data,
        select: TAG_SELECT,
      });

      return toResponse(tag);
    } catch (error) {
      throw duplicateNameOr(error);
    }
  }

  /**
   * Baja lógica de la etiqueta, pero borrado real de las asignaciones.
   *
   * Son cosas distintas a propósito: la etiqueta se archiva (por si hay que
   * auditar quién la creó), pero dejar las asignaciones colgando haría que
   * recrear una etiqueta con el mismo nombre reviviera las viejas — la nueva
   * fila tendría otro id, sí, pero el conteo de la vieja seguiría inflado y las
   * filas quedarían para siempre sin dueño alcanzable.
   */
  async remove(id: string): Promise<void> {
    await this.findTagOrFail(id);

    await this.prisma.scoped.$transaction(async (tx) => {
      await tx.customerTagAssignment.deleteMany({ where: { tagId: id } });
      await tx.customerTag.delete({ where: { id } });
    });
  }

  /** Toda operación sobre una etiqueta ajena o inexistente muere acá. */
  private async findTagOrFail(id: string): Promise<TagRow> {
    const tag = await this.prisma.scoped.customerTag.findFirst({
      where: { id },
      select: TAG_SELECT,
    });

    if (!tag) {
      throw new NotFoundException('La etiqueta no existe');
    }

    return tag;
  }
}

function toResponse(row: TagRow): CustomerTagResponseDto {
  const { _count, ...tag } = row;

  return { ...tag, customerCount: _count.assignments };
}

/** El único UNIQUE posible es el índice parcial `(tenant_id, lower(name))`. */
function duplicateNameOr(error: unknown): unknown {
  const isUniqueViolation =
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002';

  return isUniqueViolation
    ? new ConflictException('Ya tenés una etiqueta con ese nombre')
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
