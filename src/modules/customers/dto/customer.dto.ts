import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  PaginationMetaDto,
  PaginationQueryDto,
} from '../../../common/dto/pagination.dto';
import { DATE_ONLY_PATTERN } from '../../../common/utils/date-only.util';
import { lowercaseTrim, trim } from '../../../common/utils/trim.transform';

/**
 * Forma laxa a propósito: dígitos, espacios y los separadores que la gente usa.
 * Lo que decide si dos teléfonos son el mismo es `normalizePhone`, no este
 * regex; acá solo se filtra el texto libre.
 *
 * El primer carácter admite `+` y `(` además del dígito: `(011) 5555-1234` es
 * una forma perfectamente normal de anotar un número.
 */
const PHONE_PATTERN = '^[+(\\d][\\d\\s().+-]{4,29}$';

const PHONE_MESSAGE =
  'El teléfono solo puede tener números, espacios y los signos + ( ) - .';

const DATE_MESSAGE =
  'La fecha tiene que ser YYYY-MM-DD (por ejemplo 1990-04-25)';

/** Tope de etiquetas por cliente: es segmentación, no un tacho de notas. */
export const MAX_CUSTOMER_TAGS = 20;

export class CustomerTagSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'VIP' }) name!: string;

  @ApiProperty({ nullable: true, type: String, example: '#7C3AED' })
  color!: string | null;
}

export class CustomerResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'María' }) firstName!: string;

  @ApiProperty({ nullable: true, type: String, example: 'González' })
  lastName!: string | null;

  @ApiProperty({
    example: '+54 9 11 5555-1234',
    description: 'Tal como se cargó. Es lo que hay que mostrar y marcar.',
  })
  phone!: string;

  @ApiProperty({ nullable: true, type: String })
  email!: string | null;

  @ApiProperty({ nullable: true, type: String, example: '1990-04-25' })
  dateOfBirth!: string | null;

  @ApiProperty({ nullable: true, type: String })
  notes!: string | null;

  @ApiProperty({ type: [CustomerTagSummaryDto] })
  tags!: CustomerTagSummaryDto[];

  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class PaginatedCustomersDto {
  @ApiProperty({ type: [CustomerResponseDto] })
  data!: CustomerResponseDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta!: PaginationMetaDto;
}

/** Cuerpo del 409 cuando el teléfono ya está cargado. */
export class DuplicateCustomerDto {
  @ApiProperty({ example: 409 }) statusCode!: number;
  @ApiProperty({ example: 'Ya tenés un cliente con ese teléfono' })
  message!: string;

  @ApiProperty({ example: 'Conflict' }) error!: string;

  @ApiProperty({
    type: CustomerResponseDto,
    description:
      'La ficha que ya existía. Alcanza para ofrecer "¿es esta persona?" sin ' +
      'tener que ir a buscarla con otra request.',
  })
  existingCustomer!: CustomerResponseDto;
}

export class CreateCustomerDto {
  @ApiProperty({ example: 'María', maxLength: 100 })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  firstName!: string;

  @ApiPropertyOptional({ example: 'González', maxLength: 100 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  lastName?: string | null;

  @ApiProperty({
    example: '+54 9 11 5555-1234',
    pattern: PHONE_PATTERN,
    description:
      'Obligatorio: es lo que identifica a la persona. Si ya existe en el ' +
      'negocio, la respuesta es 409 con la ficha existente.',
  })
  @Transform(trim)
  @Matches(new RegExp(PHONE_PATTERN), { message: PHONE_MESSAGE })
  phone!: string;

  @ApiPropertyOptional({
    description: 'No es único: dos clientes pueden compartir casilla.',
  })
  @IsOptional()
  @Transform(lowercaseTrim)
  @IsEmail({}, { message: 'El email no tiene un formato válido' })
  @MaxLength(255)
  email?: string | null;

  @ApiPropertyOptional({ example: '1990-04-25', pattern: DATE_ONLY_PATTERN })
  @IsOptional()
  @Matches(new RegExp(DATE_ONLY_PATTERN), { message: DATE_MESSAGE })
  dateOfBirth?: string | null;

  @ApiPropertyOptional({
    maxLength: 5000,
    description: 'Notas de mostrador. Lo clínico va aparte (Fase 6).',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(5000)
  notes?: string | null;
}

/**
 * El teléfono SÍ se puede editar (la gente cambia de número), pero pasa por el
 * mismo chequeo de duplicados que el alta: no sirve de nada bloquear el `POST`
 * si un `PATCH` puede dejar dos fichas con el mismo número.
 */
export class UpdateCustomerDto {
  @ApiPropertyOptional({ example: 'María', maxLength: 100 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  firstName?: string;

  @ApiPropertyOptional({
    nullable: true,
    maxLength: 100,
    description: '`null` lo borra.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  lastName?: string | null;

  @ApiPropertyOptional({
    example: '+54 9 11 5555-1234',
    pattern: PHONE_PATTERN,
  })
  @IsOptional()
  @Transform(trim)
  @Matches(new RegExp(PHONE_PATTERN), { message: PHONE_MESSAGE })
  phone?: string;

  @ApiPropertyOptional({ nullable: true, description: '`null` lo borra.' })
  @IsOptional()
  @Transform(lowercaseTrim)
  @IsEmail({}, { message: 'El email no tiene un formato válido' })
  @MaxLength(255)
  email?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: '1990-04-25',
    pattern: DATE_ONLY_PATTERN,
  })
  @IsOptional()
  @Matches(new RegExp(DATE_ONLY_PATTERN), { message: DATE_MESSAGE })
  dateOfBirth?: string | null;

  @ApiPropertyOptional({ nullable: true, maxLength: 5000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(5000)
  notes?: string | null;
}

/** Query string de `GET /customers`. */
export class ListCustomersQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    example: 'maría gonzález',
    description:
      'Busca en nombre, apellido, email y teléfono a la vez. Con varias ' +
      'palabras, todas tienen que aparecer en el nombre completo (en ' +
      'cualquier orden). Los teléfonos se comparan normalizados: buscar ' +
      '`+54 9 11 5555-1234` encuentra al que se cargó como `11 5555-1234`.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional({ description: 'Solo los clientes con esta etiqueta.' })
  @IsOptional()
  @IsUUID()
  tagId?: string;
}

/** Cuerpo de `PUT /customers/:id/tags`. Reemplaza el set completo. */
export class SetCustomerTagsDto {
  @ApiProperty({
    type: [String],
    maxItems: MAX_CUSTOMER_TAGS,
    description: 'Las etiquetas que quedan puestas. `[]` se las saca todas.',
  })
  @IsArray()
  @ArrayMaxSize(MAX_CUSTOMER_TAGS)
  @IsUUID(undefined, { each: true })
  tagIds!: string[];
}
