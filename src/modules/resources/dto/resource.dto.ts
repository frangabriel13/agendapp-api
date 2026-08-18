import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { booleanQueryParam } from '../../../common/utils/boolean-query.transform';
import { trim } from '../../../common/utils/trim.transform';

export class ResourceBranchSummaryDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Sucursal Centro' }) name!: string;
}

export class ResourceResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Camilla 1' }) name!: string;

  @ApiProperty({ nullable: true, type: String })
  description!: string | null;

  @ApiProperty({
    type: ResourceBranchSummaryDto,
    description: 'El recurso está físicamente en una sola sucursal.',
  })
  branch!: ResourceBranchSummaryDto;

  @ApiProperty({
    description: 'Un recurso inactivo no se reserva, pero no se borra.',
  })
  isActive!: boolean;

  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class CreateResourceDto {
  @ApiProperty({ example: 'Camilla 1', maxLength: 120 })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ description: 'Sucursal donde está el recurso.' })
  @IsUUID()
  branchId!: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  description?: string | null;
}

/**
 * La sucursal NO se edita: mover un recurso de lugar es, a efectos de la
 * agenda, otro recurso. Cambiarla dejaría turnos futuros reservados sobre algo
 * que ya no está ahí.
 */
export class UpdateResourceDto {
  @ApiPropertyOptional({ example: 'Camilla 1', maxLength: 120 })
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
    description: 'Desactivarlo lo saca de la reserva sin perder el historial.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** Query string de `GET /resources`. */
export class ListResourcesQueryDto {
  @ApiPropertyOptional({ description: 'Filtra por sucursal.' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({
    description: 'Filtra por estado. Si se omite, vienen todos.',
  })
  @IsOptional()
  @Transform(booleanQueryParam('isActive'))
  @IsBoolean()
  isActive?: boolean;
}
