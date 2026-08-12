import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { booleanQueryParam } from '../../../common/utils/boolean-query.transform';
import { trim } from '../../../common/utils/trim.transform';
import {
  BusinessHourDto,
  BusinessHourResponseDto,
  DAYS_IN_WEEK,
} from './business-hours.dto';

/** Respuesta de las sucursales en las listas. */
export class BranchResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Sucursal Centro' }) name!: string;

  @ApiProperty({ nullable: true, type: String, example: 'Av. Corrientes 1234' })
  address!: string | null;

  @ApiProperty({ nullable: true, type: String, example: '+54 11 5555-5555' })
  phone!: string | null;

  @ApiProperty({
    description: 'Una sucursal inactiva no toma turnos, pero sigue existiendo.',
  })
  isActive!: boolean;

  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

/** Respuesta del detalle: la sucursal con su semana. */
export class BranchDetailResponseDto extends BranchResponseDto {
  @ApiProperty({ type: [BusinessHourResponseDto] })
  businessHours!: BusinessHourResponseDto[];
}

export class CreateBranchDto {
  @ApiProperty({ example: 'Sucursal Centro', maxLength: 120 })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ example: 'Av. Corrientes 1234', maxLength: 255 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(255)
  address?: string | null;

  @ApiPropertyOptional({ example: '+54 11 5555-5555', maxLength: 30 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(30)
  phone?: string | null;

  @ApiPropertyOptional({
    type: [BusinessHourDto],
    description:
      `Los ${DAYS_IN_WEEK} días de la semana. Si se omite, la sucursal nace ` +
      'abierta de lunes a viernes de 09:00 a 18:00 y cerrada el fin de semana.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(DAYS_IN_WEEK)
  @ArrayMaxSize(DAYS_IN_WEEK)
  @ValidateNested({ each: true })
  @Type(() => BusinessHourDto)
  businessHours?: BusinessHourDto[];
}

/**
 * Los horarios NO se editan por acá: van por `PUT /branches/:id/business-hours`,
 * que reemplaza la semana entera.
 */
export class UpdateBranchDto {
  @ApiPropertyOptional({ example: 'Sucursal Centro', maxLength: 120 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({
    nullable: true,
    example: 'Av. Corrientes 1234',
    description: '`null` borra la dirección.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(255)
  address?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: '+54 11 5555-5555',
    description: '`null` borra el teléfono.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(30)
  phone?: string | null;

  @ApiPropertyOptional({
    description: 'Desactivar una sucursal la saca de la agenda sin borrarla.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Query string de `GET /branches`. */
export class ListBranchesQueryDto {
  @ApiPropertyOptional({
    description: 'Filtra por estado. Si se omite, vienen todas.',
  })
  @IsOptional()
  @Transform(booleanQueryParam('isActive'))
  @IsBoolean()
  isActive?: boolean;
}
