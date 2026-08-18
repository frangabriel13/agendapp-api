import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { trim } from '../../../common/utils/trim.transform';

/** Tope del `displayOrder`: alcanza de sobra y evita que entre un int32 al borde. */
export const MAX_DISPLAY_ORDER = 9999;

export class ServiceCategoryResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Color' }) name!: string;

  @ApiProperty({
    description:
      'Orden en que se muestran las categorías. A igual valor, alfabético.',
    example: 0,
  })
  displayOrder!: number;

  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class CreateServiceCategoryDto {
  @ApiProperty({ example: 'Color', maxLength: 120 })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ example: 0, minimum: 0, maximum: MAX_DISPLAY_ORDER })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_DISPLAY_ORDER)
  displayOrder?: number;
}

export class UpdateServiceCategoryDto {
  @ApiPropertyOptional({ example: 'Color', maxLength: 120 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ example: 0, minimum: 0, maximum: MAX_DISPLAY_ORDER })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_DISPLAY_ORDER)
  displayOrder?: number;
}
