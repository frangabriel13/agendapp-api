import { ApiProperty } from '@nestjs/swagger';
import {
  IsNotEmpty,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

export class ChangePasswordDto {
  @ApiProperty({ example: 'clave1234' })
  @IsString()
  @IsNotEmpty({ message: 'La contraseña actual es obligatoria' })
  @MaxLength(128)
  currentPassword!: string;

  @ApiProperty({
    example: 'nuevaClave456',
    minLength: 8,
    description: 'Mínimo 8 caracteres, con al menos una letra y un número.',
  })
  @IsString()
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres' })
  @MaxLength(128)
  @Matches(/^(?=.*[A-Za-z])(?=.*\d).+$/, {
    message: 'La contraseña debe incluir al menos una letra y un número',
  })
  newPassword!: string;
}
