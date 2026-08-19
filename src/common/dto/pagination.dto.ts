import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * Paginación compartida. La estrena `GET /customers` (Fase 4) y la van a usar
 * el historial de turnos y el de pagos.
 *
 * Es paginación por offset (`page`/`pageSize`), no por cursor: las pantallas
 * que la consumen son grillas con números de página, y los volúmenes acá son de
 * miles de filas, no de millones. Si algún listado crece a un orden donde el
 * `OFFSET` empiece a doler, ese endpoint puntual pasa a cursor — no todos.
 */

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

/** Query params de cualquier listado paginado. Se extiende, no se usa sola. */
export class PaginationQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    default: 1,
    description: 'Empieza en 1, no en 0.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: DEFAULT_PAGE_SIZE,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize?: number;
}

export class PaginationMetaDto {
  @ApiProperty({ example: 1 }) page!: number;
  @ApiProperty({ example: DEFAULT_PAGE_SIZE }) pageSize!: number;

  @ApiProperty({
    example: 137,
    description: 'Total de filas que matchean, ignorando la paginación.',
  })
  total!: number;

  @ApiProperty({
    example: 7,
    description: '`0` cuando no hay resultados, no `1`.',
  })
  totalPages!: number;
}

/** `{ page, pageSize, skip, take }` normalizados a partir de la query. */
export function resolvePagination(query: PaginationQueryDto): {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
} {
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

/**
 * Arma el `meta` de la respuesta.
 *
 * Pedir una página más allá del final devuelve `data: []` y no un 404: para una
 * grilla, "no hay nada acá" es una respuesta válida, y un error obligaría al
 * front a manejar una carrera trivial (alguien borró filas mientras paginabas).
 */
export function paginationMeta(
  total: number,
  { page, pageSize }: { page: number; pageSize: number },
): PaginationMetaDto {
  return { page, pageSize, total, totalPages: Math.ceil(total / pageSize) };
}
