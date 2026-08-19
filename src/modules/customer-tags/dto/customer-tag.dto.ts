import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { trim } from '../../../common/utils/trim.transform';

/** `#RRGGBB`. Igual que en servicios: el front lo pinta sin traducir nada. */
const HEX_COLOR_PATTERN = '^#[0-9A-Fa-f]{6}$';

const COLOR_MESSAGE = 'El color tiene que ser hexadecimal, tipo #7C3AED';

export class CustomerTagResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'VIP' }) name!: string;

  @ApiProperty({ nullable: true, type: String, example: '#7C3AED' })
  color!: string | null;

  @ApiProperty({
    example: 42,
    description:
      'Cuántos clientes activos la tienen puesta. Sirve para avisar antes de ' +
      'dar de baja una etiqueta que está en uso.',
  })
  customerCount!: number;

  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class CreateCustomerTagDto {
  @ApiProperty({ example: 'VIP', maxLength: 60 })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name!: string;

  @ApiPropertyOptional({ example: '#7C3AED', pattern: HEX_COLOR_PATTERN })
  @IsOptional()
  @Transform(trim)
  @Matches(new RegExp(HEX_COLOR_PATTERN), { message: COLOR_MESSAGE })
  color?: string | null;
}

export class UpdateCustomerTagDto {
  @ApiPropertyOptional({ example: 'VIP', maxLength: 60 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  name?: string;

  @ApiPropertyOptional({
    nullable: true,
    pattern: HEX_COLOR_PATTERN,
    description: '`null` la deja sin color.',
  })
  @IsOptional()
  @Transform(trim)
  @Matches(new RegExp(HEX_COLOR_PATTERN), { message: COLOR_MESSAGE })
  color?: string | null;
}
