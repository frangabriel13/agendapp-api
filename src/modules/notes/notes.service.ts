import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EmployeeRole, NoteEntityType, Prisma } from '@prisma/client';
import {
  paginationMeta,
  resolvePagination,
} from '../../common/dto/pagination.dto';
import { scopedCreate } from '../../prisma/extensions';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedUser } from '../auth/types/jwt-payload';
import type {
  CreateNoteDto,
  ListNotesQueryDto,
  NoteResponseDto,
  PaginatedNotesDto,
  UpdateNoteDto,
} from './dto/note.dto';

const NOTE_SELECT = {
  id: true,
  content: true,
  isPrivate: true,
  entityType: true,
  entityId: true,
  authorUserId: true,
  createdAt: true,
  updatedAt: true,
  author: { select: { id: true, firstName: true, lastName: true } },
} satisfies Prisma.NoteSelect;

type NoteRow = Prisma.NoteGetPayload<{ select: typeof NOTE_SELECT }>;

/**
 * La bitácora interna del negocio.
 *
 * Dos reglas atraviesan el archivo:
 *
 * 1. **`isPrivate` se aplica en el `WHERE`, no al armar la respuesta.** La nota
 *    ajena y privada no se filtra después: directamente no se trae. Filtrar en
 *    memoria funciona igual hasta que alguien agrega un `count`, un `groupBy` o
 *    una exportación y se olvida de repetir la regla — y ahí "privada" pasa a
 *    ser una palabra que miente en la pantalla.
 * 2. **Editar y borrar es del autor o del `OWNER`.** No hay `@Roles` que sirva
 *    para esto: la regla depende de la fila, no del endpoint.
 */
@Injectable()
export class NotesService {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    dto: CreateNoteDto,
    user: AuthenticatedUser,
  ): Promise<NoteResponseDto> {
    await this.assertEntityExists(dto.entityType, dto.entityId);

    const note = await this.prisma.scoped.note.create({
      data: scopedCreate<Prisma.NoteUncheckedCreateInput>({
        authorUserId: user.userId,
        content: dto.content,
        entityType: dto.entityType,
        entityId: dto.entityId ?? null,
        // Sin `isPrivate` queda pública por el default de la columna. No se
        // fuerza acá para que el default viva en un solo lado.
        ...(dto.isPrivate === undefined ? {} : { isPrivate: dto.isPrivate }),
      }),
      select: NOTE_SELECT,
    });

    return toResponse(note);
  }

  async findAll(
    query: ListNotesQueryDto,
    user: AuthenticatedUser,
  ): Promise<PaginatedNotesDto> {
    if (query.entityId !== undefined && query.entityType === undefined) {
      throw new BadRequestException(
        'Para filtrar por `entityId` hay que decir también de qué `entityType` es',
      );
    }

    const where: Prisma.NoteWhereInput = {
      ...(query.entityType === undefined
        ? {}
        : { entityType: query.entityType }),
      ...(query.entityId === undefined ? {} : { entityId: query.entityId }),
      ...this.visibleTo(user),
    };

    const { page, pageSize, skip, take } = resolvePagination(query);

    const [rows, total] = await Promise.all([
      this.prisma.scoped.note.findMany({
        where,
        select: NOTE_SELECT,
        // De lo más nuevo: una bitácora se lee por arriba.
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.scoped.note.count({ where }),
    ]);

    return {
      data: rows.map(toResponse),
      meta: paginationMeta(total, { page, pageSize }),
    };
  }

  async findOne(id: string, user: AuthenticatedUser): Promise<NoteResponseDto> {
    return toResponse(await this.findVisibleOrFail(id, user));
  }

  async update(
    id: string,
    dto: UpdateNoteDto,
    user: AuthenticatedUser,
  ): Promise<NoteResponseDto> {
    await this.assertCanWrite(id, user);

    const note = await this.prisma.scoped.note.update({
      where: { id },
      data: {
        ...(dto.content === undefined ? {} : { content: dto.content }),
        ...(dto.isPrivate === undefined ? {} : { isPrivate: dto.isPrivate }),
      },
      select: NOTE_SELECT,
    });

    return toResponse(note);
  }

  async remove(id: string, user: AuthenticatedUser): Promise<void> {
    await this.assertCanWrite(id, user);

    await this.prisma.scoped.note.delete({ where: { id } });
  }

  /**
   * Qué notas puede ver esta persona, como fragmento de `WHERE`.
   *
   * El `OWNER` las ve todas —es su negocio y responde por lo que se escribe
   * ahí—; el resto ve las públicas y las propias.
   */
  private visibleTo(user: AuthenticatedUser): Prisma.NoteWhereInput {
    if (user.role === EmployeeRole.OWNER) {
      return {};
    }

    return { OR: [{ isPrivate: false }, { authorUserId: user.userId }] };
  }

  private async findVisibleOrFail(
    id: string,
    user: AuthenticatedUser,
  ): Promise<NoteRow> {
    const note = await this.prisma.scoped.note.findFirst({
      where: { id, ...this.visibleTo(user) },
      select: NOTE_SELECT,
    });

    if (!note) {
      // 404 y no 403 para una nota privada ajena: un 403 confirmaría que
      // existe, que es justo lo que "privada" tiene que esconder.
      throw new NotFoundException('La nota no existe');
    }

    return note;
  }

  /** Escribir es más restrictivo que ver: el autor, o el dueño del negocio. */
  private async assertCanWrite(
    id: string,
    user: AuthenticatedUser,
  ): Promise<void> {
    const note = await this.findVisibleOrFail(id, user);

    if (note.authorUserId !== user.userId && user.role !== EmployeeRole.OWNER) {
      throw new ForbiddenException(
        'Solo quien la escribió (o el dueño del negocio) puede editar o borrar una nota',
      );
    }
  }

  /**
   * Las dos preguntas sobre el destino, en el orden en que hay que hacerlas:
   * **si corresponde que haya uno**, y **si existe**.
   *
   * La primera vive acá y no en el DTO porque es una regla entre dos campos:
   * dos `@ValidateIf` sobre la misma propiedad se pisan entre sí, y el
   * resultado era que ninguna de las dos mitades se aplicaba y el error salía
   * del CHECK de la base como un 500. El CHECK sigue estando; lo que cambia es
   * que ya no es quien contesta.
   *
   * La segunda es lo que compensa no tener FK: la nota polimórfica no puede
   * tener una, así que la garantía la da esta consulta. **La extension de
   * tenant-scope hace la mitad del trabajo** —una entidad de otro negocio no
   * aparece— y por eso el mensaje puede ser "no existe" sin mentir.
   */
  private async assertEntityExists(
    entityType: NoteEntityType,
    entityId: string | undefined,
  ): Promise<void> {
    if (entityType === NoteEntityType.GENERAL) {
      if (entityId !== undefined) {
        throw new BadRequestException(
          'Una nota general es del negocio y no lleva `entityId`',
        );
      }

      return;
    }

    if (entityId === undefined) {
      throw new BadRequestException(
        `Una nota sobre ${ENTITY_LABEL[entityType]} necesita su \`entityId\``,
      );
    }

    const exists = await this.entityLookup(entityType, entityId);

    if (!exists) {
      throw new BadRequestException(
        `No existe ${ENTITY_LABEL[entityType]} con ese id en tu negocio`,
      );
    }
  }

  private async entityLookup(
    entityType: NoteEntityType,
    id: string,
  ): Promise<boolean> {
    const where = { id };
    const select = { id: true };

    switch (entityType) {
      case NoteEntityType.CUSTOMER:
        return Boolean(
          await this.prisma.scoped.customer.findFirst({ where, select }),
        );
      case NoteEntityType.APPOINTMENT:
        return Boolean(
          await this.prisma.scoped.appointment.findFirst({ where, select }),
        );
      case NoteEntityType.EMPLOYEE:
        return Boolean(
          await this.prisma.scoped.employee.findFirst({ where, select }),
        );
      case NoteEntityType.BRANCH:
        return Boolean(
          await this.prisma.scoped.branch.findFirst({ where, select }),
        );
      case NoteEntityType.GENERAL:
        return true;
    }
  }
}

/** Para el mensaje de error, en castellano y con el artículo puesto. */
const ENTITY_LABEL: Record<NoteEntityType, string> = {
  [NoteEntityType.CUSTOMER]: 'un cliente',
  [NoteEntityType.APPOINTMENT]: 'un turno',
  [NoteEntityType.EMPLOYEE]: 'un empleado',
  [NoteEntityType.BRANCH]: 'una sucursal',
  [NoteEntityType.GENERAL]: 'una entidad',
};

function toResponse(note: NoteRow): NoteResponseDto {
  return {
    id: note.id,
    author: {
      id: note.author.id,
      firstName: note.author.firstName,
      lastName: note.author.lastName,
    },
    content: note.content,
    isPrivate: note.isPrivate,
    entityType: note.entityType,
    entityId: note.entityId,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
  };
}
