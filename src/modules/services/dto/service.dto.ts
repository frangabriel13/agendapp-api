import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { booleanQueryParam } from '../../../common/utils/boolean-query.transform';
import { trim } from '../../../common/utils/trim.transform';

/** Un servicio más largo que un día no es un turno, es otra cosa. */
export const MAX_DURATION_MINUTES = 1440;

/** El color va directo al calendario del front como CSS. */
export const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

export class ServiceCategorySummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Color' }) name!: string;
}

export class ServiceResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Corte de dama' }) name!: string;

  @ApiProperty({ nullable: true, type: String })
  description!: string | null;

  @ApiProperty({
    nullable: true,
    type: ServiceCategorySummaryDto,
    description: 'Queda en `null` si se dio de baja la categoría.',
  })
  category!: ServiceCategorySummaryDto | null;

  @ApiProperty({
    example: 45,
    description: 'Cuánto ocupa el turno. Define los slots de la agenda.',
  })
  durationMinutes!: number;

  @ApiProperty({
    example: 1500000,
    description: 'En **centavos**. 1500000 = $15.000.',
  })
  priceCents!: number;

  @ApiProperty({
    nullable: true,
    type: Number,
    example: 500000,
    description: 'Seña en centavos. `null` = el servicio no pide seña.',
  })
  depositAmountCents!: number | null;

  @ApiProperty({
    example: 10,
    description: 'Minutos de limpieza o preparación después del turno.',
  })
  bufferAfterMinutes!: number;

  @ApiProperty({ nullable: true, type: String, example: '#7C3AED' })
  color!: string | null;

  @ApiProperty({
    description: 'Un servicio inactivo no se puede reservar, pero no se borra.',
  })
  isActive!: boolean;

  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class CreateServiceDto {
  @ApiProperty({ example: 'Corte de dama', maxLength: 120 })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiPropertyOptional({
    description: 'Categoría a la que pertenece. Sin ella queda sin agrupar.',
  })
  @IsOptional()
  @IsUUID()
  categoryId?: string | null;

  @ApiProperty({ example: 45, minimum: 1, maximum: MAX_DURATION_MINUTES })
  @IsInt()
  @Min(1)
  @Max(MAX_DURATION_MINUTES)
  durationMinutes!: number;

  @ApiProperty({
    example: 1500000,
    minimum: 0,
    description: 'En **centavos**. 0 es válido (una consulta sin cargo).',
  })
  @IsInt()
  @Min(0)
  priceCents!: number;

  @ApiPropertyOptional({
    example: 500000,
    minimum: 0,
    description: 'Seña en centavos. No puede superar al precio.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  depositAmountCents?: number | null;

  @ApiPropertyOptional({
    example: 10,
    minimum: 0,
    maximum: MAX_DURATION_MINUTES,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_DURATION_MINUTES)
  bufferAfterMinutes?: number;

  @ApiPropertyOptional({
    example: '#7C3AED',
    description: 'Formato `#RRGGBB`.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(HEX_COLOR, { message: 'color debe tener el formato #RRGGBB' })
  color?: string | null;
}

export class UpdateServiceDto {
  @ApiPropertyOptional({ example: 'Corte de dama', maxLength: 120 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({
    nullable: true,
    maxLength: 2000,
    description: '`null` borra la descripción.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    description: '`null` deja el servicio sin categoría.',
  })
  @IsOptional()
  @IsUUID()
  categoryId?: string | null;

  @ApiPropertyOptional({
    example: 45,
    minimum: 1,
    maximum: MAX_DURATION_MINUTES,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(MAX_DURATION_MINUTES)
  durationMinutes?: number;

  @ApiPropertyOptional({ example: 1500000, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  priceCents?: number;

  @ApiPropertyOptional({
    nullable: true,
    example: 500000,
    minimum: 0,
    description: '`null` saca la seña.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  depositAmountCents?: number | null;

  @ApiPropertyOptional({
    example: 10,
    minimum: 0,
    maximum: MAX_DURATION_MINUTES,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_DURATION_MINUTES)
  bufferAfterMinutes?: number;

  @ApiPropertyOptional({
    nullable: true,
    example: '#7C3AED',
    description: '`null` saca el color.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @Matches(HEX_COLOR, { message: 'color debe tener el formato #RRGGBB' })
  color?: string | null;

  @ApiPropertyOptional({
    description: 'Desactivarlo lo saca de la reserva sin perder el historial.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Query string de `GET /services`. */
export class ListServicesQueryDto {
  @ApiPropertyOptional({
    description: 'Filtra por estado. Si se omite, vienen todos.',
  })
  @IsOptional()
  @Transform(booleanQueryParam('isActive'))
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    description: 'Filtra por categoría.',
  })
  @IsOptional()
  @IsUUID()
  categoryId?: string;
}
