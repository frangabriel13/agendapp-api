import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  paginationMeta,
  resolvePagination,
} from '../../common/dto/pagination.dto';
import {
  dateToDateOnly,
  parseDateOnly,
} from '../../common/utils/date-only.util';
import {
  hasComparablePhone,
  normalizePhone,
} from '../../common/utils/phone.util';
import { scopedCreate } from '../../prisma/extensions';
import { PrismaService } from '../../prisma/prisma.service';
import type {
  CreateCustomerDto,
  CustomerResponseDto,
  CustomerTagSummaryDto,
  ListCustomersQueryDto,
  PaginatedCustomersDto,
  SetCustomerTagsDto,
  UpdateCustomerDto,
} from './dto/customer.dto';

/**
 * El `where` de las etiquetas es explícito porque la extension de soft-delete
 * solo toca el nivel de arriba: sin él, una etiqueta dada de baja seguiría
 * apareciendo colgada del cliente.
 */
const CUSTOMER_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  phone: true,
  email: true,
  dateOfBirth: true,
  notes: true,
  createdAt: true,
  updatedAt: true,
  tagAssignments: {
    where: { tag: { deletedAt: null } },
    select: { tag: { select: { id: true, name: true, color: true } } },
    orderBy: { tag: { name: 'asc' } },
  },
} satisfies Prisma.CustomerSelect;

type CustomerRow = Prisma.CustomerGetPayload<{
  select: typeof CUSTOMER_SELECT;
}>;

/** Buscar por un solo dígito traería el padrón entero: no vale como teléfono. */
const MIN_PHONE_SEARCH_DIGITS = 3;

/**
 * Clientes del negocio. No se logean: los carga el mostrador, y en la Fase 7
 * los va a crear también el portal público al reservar.
 *
 * **La identidad de un cliente es su teléfono.** Es lo único que siempre se
 * pide y lo que permite reconocer a alguien que vuelve, así que hay un unique
 * parcial sobre `(tenant_id, phone_normalized)` y tanto el alta como la edición
 * pasan por el mismo chequeo. Ante un repetido la API **rechaza con 409** y
 * devuelve la ficha existente en el cuerpo, en vez de fusionar por su cuenta:
 * dos personas pueden compartir teléfono (una madre y su hija, una pareja) y un
 * merge silencioso uniría dos historiales sin que nadie lo pida. Quien decide
 * es el mostrador, que es el único que sabe quién está parado enfrente.
 */
@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  async create(dto: CreateCustomerDto): Promise<CustomerResponseDto> {
    const phoneNormalized = normalizeOrFail(dto.phone);

    await this.assertPhoneIsFree(phoneNormalized);

    try {
      const customer = await this.prisma.scoped.customer.create({
        data: scopedCreate<Prisma.CustomerUncheckedCreateInput>({
          firstName: dto.firstName,
          lastName: dto.lastName ?? null,
          phone: dto.phone,
          phoneNormalized,
          email: dto.email ?? null,
          dateOfBirth: parseBirthDate(dto.dateOfBirth),
          notes: dto.notes ?? null,
        }),
        select: CUSTOMER_SELECT,
      });

      return toResponse(customer);
    } catch (error) {
      throw await this.duplicatePhoneOr(error, phoneNormalized);
    }
  }

  async findAll(query: ListCustomersQueryDto): Promise<PaginatedCustomersDto> {
    const { page, pageSize, skip, take } = resolvePagination(query);
    const where = buildSearchWhere(query);

    // En paralelo y sin transacción: si alguien da de alta un cliente entre las
    // dos consultas, el `total` puede quedar corrido por uno. Para una grilla
    // eso no significa nada, y evitarlo pediría REPEATABLE READ con su reintento
    // — mucho aparato para un número que además cambia mientras se lee.
    const [rows, total] = await Promise.all([
      this.prisma.scoped.customer.findMany({
        where,
        select: CUSTOMER_SELECT,
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
        skip,
        take,
      }),
      this.prisma.scoped.customer.count({ where }),
    ]);

    return {
      data: rows.map(toResponse),
      meta: paginationMeta(total, { page, pageSize }),
    };
  }

  async findOne(id: string): Promise<CustomerResponseDto> {
    return toResponse(await this.findCustomerOrFail(id));
  }

  async update(
    id: string,
    dto: UpdateCustomerDto,
  ): Promise<CustomerResponseDto> {
    const current = await this.findCustomerOrFail(id);

    // El teléfono viaja con su normalizado: son un solo dato en dos columnas y
    // dejarlos desincronizados rompería el unique sin que nadie lo note.
    const phoneNormalized =
      dto.phone === undefined ? undefined : normalizeOrFail(dto.phone);

    if (phoneNormalized !== undefined) {
      await this.assertPhoneIsFree(phoneNormalized, id);
    }

    const data = pickDefined<Prisma.CustomerUncheckedUpdateInput>({
      firstName: dto.firstName,
      lastName: dto.lastName,
      phone: dto.phone,
      phoneNormalized,
      email: dto.email,
      dateOfBirth:
        dto.dateOfBirth === undefined
          ? undefined
          : parseBirthDate(dto.dateOfBirth),
      notes: dto.notes,
    });

    if (isEmpty(data)) {
      return toResponse(current);
    }

    try {
      const customer = await this.prisma.scoped.customer.update({
        where: { id, deletedAt: null },
        data,
        select: CUSTOMER_SELECT,
      });

      return toResponse(customer);
    } catch (error) {
      throw await this.duplicatePhoneOr(error, phoneNormalized, id);
    }
  }

  /**
   * Baja lógica. Las etiquetas puestas quedan en la base pero dejan de
   * contarse: `CustomerTagsService` filtra por clientes vivos.
   *
   * Los turnos del cliente (Fase 5) no se tocan: el historial de lo que pasó en
   * el negocio no depende de si la ficha sigue en la lista.
   */
  async remove(id: string): Promise<void> {
    await this.findCustomerOrFail(id);
    await this.prisma.scoped.customer.delete({ where: { id } });
  }

  async findTags(id: string): Promise<CustomerTagSummaryDto[]> {
    const customer = await this.findCustomerOrFail(id);

    return toResponse(customer).tags;
  }

  /**
   * Reemplaza el set completo, igual que las asignaciones del catálogo: el
   * front manda las etiquetas que quedan puestas, no un delta.
   */
  async setTags(
    id: string,
    dto: SetCustomerTagsDto,
  ): Promise<CustomerTagSummaryDto[]> {
    await this.findCustomerOrFail(id);

    const tagIds = dto.tagIds;

    if (new Set(tagIds).size !== tagIds.length) {
      throw new BadRequestException('Hay etiquetas repetidas en la lista');
    }

    await this.assertTagsExist(tagIds);

    await this.prisma.scoped.$transaction(async (tx) => {
      await tx.customerTagAssignment.deleteMany({ where: { customerId: id } });

      if (tagIds.length > 0) {
        await tx.customerTagAssignment.createMany({
          data: tagIds.map((tagId) =>
            scopedCreate<Prisma.CustomerTagAssignmentUncheckedCreateInput>({
              customerId: id,
              tagId,
            }),
          ),
        });
      }
    });

    return this.findTags(id);
  }

  /**
   * Que no haya otro cliente vivo con el mismo teléfono.
   *
   * `excludeId` es para el PATCH: reguardar el mismo número en la misma ficha
   * no es un duplicado.
   */
  private async assertPhoneIsFree(
    phoneNormalized: string,
    excludeId?: string,
  ): Promise<void> {
    const existing = await this.findByPhone(phoneNormalized, excludeId);

    if (existing) {
      throw duplicatePhoneError(existing);
    }
  }

  private async findByPhone(
    phoneNormalized: string,
    excludeId?: string,
  ): Promise<CustomerRow | null> {
    return this.prisma.scoped.customer.findFirst({
      where: {
        phoneNormalized,
        ...(excludeId === undefined ? {} : { id: { not: excludeId } }),
      },
      select: CUSTOMER_SELECT,
    });
  }

  /**
   * La carrera que el chequeo previo no puede cubrir: dos altas con el mismo
   * teléfono entrando a la vez. Una pasa el `findFirst` y choca contra el
   * unique de la base. Se traduce al mismo 409 que habría dado el chequeo, para
   * que el front no tenga que distinguir dos formas del mismo error.
   */
  private async duplicatePhoneOr(
    error: unknown,
    phoneNormalized: string | undefined,
    excludeId?: string,
  ): Promise<unknown> {
    const isUniqueViolation =
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002';

    if (!isUniqueViolation || phoneNormalized === undefined) {
      return error;
    }

    const existing = await this.findByPhone(phoneNormalized, excludeId);

    return existing ? duplicatePhoneError(existing) : error;
  }

  /** Que las etiquetas existan Y sean de este negocio (la extension filtra). */
  private async assertTagsExist(tagIds: string[]): Promise<void> {
    if (tagIds.length === 0) {
      return;
    }

    const found = await this.prisma.scoped.customerTag.findMany({
      where: { id: { in: tagIds } },
      select: { id: true },
    });

    const existing = new Set(found.map((tag) => tag.id));
    const missing = tagIds.filter((tagId) => !existing.has(tagId));

    if (missing.length > 0) {
      throw new BadRequestException(
        `Estas etiquetas no existen en tu negocio: ${missing.join(', ')}`,
      );
    }
  }

  /** Toda operación sobre un cliente ajeno o inexistente muere acá. */
  private async findCustomerOrFail(id: string): Promise<CustomerRow> {
    const customer = await this.prisma.scoped.customer.findFirst({
      where: { id },
      select: CUSTOMER_SELECT,
    });

    if (!customer) {
      throw new NotFoundException('El cliente no existe');
    }

    return customer;
  }
}

/**
 * El 409 lleva la ficha existente para que el mostrador pueda decidir sin otra
 * request. Los campos extra sobreviven al filtro global gracias a
 * `extraFields` en `AllExceptionsFilter`.
 */
function duplicatePhoneError(existing: CustomerRow): ConflictException {
  return new ConflictException({
    message: 'Ya tenés un cliente con ese teléfono',
    existingCustomer: toResponse(existing),
  });
}

function toResponse(row: CustomerRow): CustomerResponseDto {
  const { tagAssignments, dateOfBirth, ...customer } = row;

  return {
    ...customer,
    dateOfBirth: dateOfBirth === null ? null : dateToDateOnly(dateOfBirth),
    tags: tagAssignments.map((assignment) => assignment.tag),
  };
}

/**
 * `undefined` (no vino en el PATCH) y `null` (borralo) son cosas distintas y
 * las dos tienen que llegar a Prisma como están.
 */
function parseBirthDate(
  value: string | null | undefined,
): Date | null | undefined {
  if (value === undefined || value === null) {
    return value;
  }

  const parsed = parseDateOnly(value);

  // El piso (1900) lo pone un CHECK; el techo no puede, porque CURRENT_DATE no
  // es IMMUTABLE. Se compara contra medianoche UTC: un día de diferencia con la
  // zona del negocio no cambia nada para una fecha de nacimiento.
  if (parsed.getTime() > Date.now()) {
    throw new BadRequestException(
      'La fecha de nacimiento no puede ser en el futuro',
    );
  }

  return parsed;
}

function normalizeOrFail(phone: string): string {
  if (!hasComparablePhone(phone)) {
    throw new BadRequestException('El teléfono tiene que tener números');
  }

  return normalizePhone(phone);
}

/**
 * Busca en nombre, apellido, email y teléfono a la vez.
 *
 * Dos detalles que hacen la diferencia en el mostrador:
 *
 * - **El teléfono se compara normalizado.** Quien busca tipea el número como se
 *   lo dictaron, no como está guardado.
 * - **Varias palabras se cruzan contra nombre Y apellido.** Sin esto, "maría
 *   gonzález" no encuentra a nadie, porque ningún campo solo contiene las dos.
 *   Cada palabra tiene que aparecer en alguno de los dos, en cualquier orden.
 */
function buildSearchWhere(
  query: ListCustomersQueryDto,
): Prisma.CustomerWhereInput {
  const where: Prisma.CustomerWhereInput = {};

  if (query.tagId !== undefined) {
    where.tagAssignments = { some: { tagId: query.tagId } };
  }

  const term = query.search?.trim();

  if (!term) {
    return where;
  }

  const insensitive = Prisma.QueryMode.insensitive;
  const words = term.split(/\s+/).filter(Boolean);
  const digits = normalizePhone(term);

  const alternatives: Prisma.CustomerWhereInput[] = [
    { firstName: { contains: term, mode: insensitive } },
    { lastName: { contains: term, mode: insensitive } },
    { email: { contains: term, mode: insensitive } },
  ];

  if (digits.length >= MIN_PHONE_SEARCH_DIGITS) {
    alternatives.push({ phoneNormalized: { contains: digits } });
  }

  if (words.length > 1) {
    alternatives.push({
      AND: words.map((word) => ({
        OR: [
          { firstName: { contains: word, mode: insensitive } },
          { lastName: { contains: word, mode: insensitive } },
        ],
      })),
    });
  }

  where.OR = alternatives;

  return where;
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
