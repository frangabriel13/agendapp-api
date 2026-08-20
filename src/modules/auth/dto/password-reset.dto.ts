import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { lowercaseTrim } from '../../../common/utils/trim.transform';

/** Body de `POST /auth/forgot-password` — endpoint público. */
export class ForgotPasswordDto {
  @ApiProperty({ example: 'ana@peluqueriaana.com', maxLength: 255 })
  @Transform(lowercaseTrim)
  @IsEmail({}, { message: 'El email no tiene un formato válido' })
  @MaxLength(255)
  email!: string;
}

/** Body de `POST /auth/reset-password` — endpoint público. */
export class ResetPasswordDto {
  @ApiProperty({
    description: 'El token del link que llegó por mail (`<id>.<secret>`).',
  })
  @IsString()
  @MaxLength(200)
  token!: string;

  // Mismas reglas que el registro y que la activación de un empleado: si
  // divergen, alguien puede elegir acá una contraseña que el login rechaza.
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
}

/** Body de `POST /auth/verify-email` — endpoint público. */
export class VerifyEmailDto {
  @ApiProperty({
    description: 'El token del link de verificación (`<id>.<secret>`).',
  })
  @IsString()
  @MaxLength(200)
  token!: string;
}
