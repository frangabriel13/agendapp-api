import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { trim } from '../../../common/utils/trim.transform';

/** Normaliza strings de entrada: recorta espacios sobrantes. */
const lowercaseTrim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export class RegisterDto {
  @ApiProperty({ example: 'ana@peluqueriaana.com', maxLength: 255 })
  @Transform(lowercaseTrim)
  @IsEmail({}, { message: 'El email no tiene un formato válido' })
  @MaxLength(255)
  email!: string;

  @ApiProperty({
    example: 'clave1234',
    minLength: 8,
    description: 'Mínimo 8 caracteres, con al menos una letra y un número.',
  })
  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
  @MaxLength(128)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
    message: 'La contraseña debe incluir al menos una letra y un número',
  })
  password!: string;

  @ApiProperty({ example: 'Ana', maxLength: 100 })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  firstName!: string;

  @ApiProperty({ example: 'Gómez', maxLength: 100 })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  lastName!: string;

  @ApiPropertyOptional({ example: '+54 9 11 5555-5555', maxLength: 30 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(30)
  @Matches(/^[+]?[\d\s()-]{6,30}$/, {
    message: 'El teléfono no tiene un formato válido',
  })
  phone?: string;

  @ApiProperty({
    example: 'Peluquería Ana',
    maxLength: 120,
    description: 'Nombre del negocio. De acá sale el slug del tenant.',
  })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  businessName!: string;
}
