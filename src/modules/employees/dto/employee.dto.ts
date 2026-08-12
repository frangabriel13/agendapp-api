import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { EmployeeRole } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  IsUrl,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { booleanQueryParam } from '../../../common/utils/boolean-query.transform';
import { DATE_ONLY_PATTERN } from '../../../common/utils/date-only.util';
import { lowercaseTrim, trim } from '../../../common/utils/trim.transform';

const DATE_MESSAGE =
  'La fecha tiene que venir como YYYY-MM-DD (ej. 2026-03-01)';

/**
 * Roles que se pueden asignar por API. `OWNER` queda afuera: el dueño se crea
 * con el negocio y hay un solo owner activo por tenant (índice parcial en la
 * base). Transferir la titularidad va a ser un flujo aparte.
 */
export const ASSIGNABLE_ROLES = [
  EmployeeRole.PROFESSIONAL,
  EmployeeRole.ADMINISTRATIVE,
] as const;

/** Si ya eligió contraseña o todavía tiene la invitación pendiente. */
export enum EmployeeStatus {
  PENDING = 'PENDING',
  ACTIVE = 'ACTIVE',
}

export class EmployeeUserDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'ana@peluqueria.test' }) email!: string;
  @ApiProperty({ example: 'Ana' }) firstName!: string;
  @ApiProperty({ example: 'Gómez' }) lastName!: string;
  @ApiProperty({ nullable: true, type: String }) phone!: string | null;
}

export class EmployeeResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: EmployeeRole }) role!: EmployeeRole;
  @ApiProperty() isOwner!: boolean;
  @ApiProperty() isActive!: boolean;

  @ApiProperty({
    enum: EmployeeStatus,
    description:
      '`PENDING` mientras no aceptó la invitación: existe pero no puede entrar.',
  })
  status!: EmployeeStatus;

  @ApiProperty({ nullable: true, type: String, example: '2026-03-01' })
  hiredAt!: string | null;

  @ApiProperty({ nullable: true, type: String }) bio!: string | null;
  @ApiProperty({ nullable: true, type: String }) avatarUrl!: string | null;
  @ApiProperty({ type: EmployeeUserDto }) user!: EmployeeUserDto;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

/** Detalle: suma en qué sucursales trabaja. */
export class EmployeeDetailResponseDto extends EmployeeResponseDto {
  @ApiProperty({
    type: [String],
    description: 'Ids de las sucursales donde trabaja.',
  })
  branchIds!: string[];
}

/** Respuesta de la invitación: acá viaja el link, una sola vez. */
export class EmployeeInvitationResponseDto {
  @ApiProperty({ type: EmployeeResponseDto }) employee!: EmployeeResponseDto;

  @ApiProperty({
    example: 'http://localhost:3000/activar?token=<id>.<secret>',
    description:
      'Link de activación. **Se muestra una sola vez**: en la base queda ' +
      'solo su hash. Si se pierde, hay que reenviar la invitación.',
  })
  activationUrl!: string;

  @ApiProperty({ description: 'Cuándo deja de servir el link.' })
  expiresAt!: Date;
}

export class InviteEmployeeDto {
  @ApiProperty({ example: 'ana@peluqueria.test', maxLength: 255 })
  @Transform(lowercaseTrim)
  @IsEmail({}, { message: 'El email no tiene un formato válido' })
  @MaxLength(255)
  email!: string;

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

  @ApiPropertyOptional({ example: '+54 11 5555-5555', maxLength: 30 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(30)
  phone?: string | null;

  @ApiProperty({
    enum: ASSIGNABLE_ROLES,
    example: EmployeeRole.PROFESSIONAL,
    description: 'El rol `OWNER` no se asigna por acá.',
  })
  @IsEnum(ASSIGNABLE_ROLES, {
    message: 'El rol tiene que ser PROFESSIONAL o ADMINISTRATIVE',
  })
  role!: (typeof ASSIGNABLE_ROLES)[number];

  @ApiPropertyOptional({ example: '2026-03-01', pattern: DATE_ONLY_PATTERN })
  @IsOptional()
  @Matches(new RegExp(DATE_ONLY_PATTERN), { message: DATE_MESSAGE })
  hiredAt?: string | null;

  @ApiPropertyOptional({ example: 'Colorista, 10 años de experiencia.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  bio?: string | null;

  @ApiPropertyOptional({ example: 'https://cdn.agendapp.com/avatars/ana.png' })
  @IsOptional()
  @Transform(trim)
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true },
    { message: 'El avatar debe ser una URL http(s) válida' },
  )
  @MaxLength(500)
  avatarUrl?: string | null;

  @ApiPropertyOptional({
    type: [String],
    description:
      'Sucursales donde va a trabajar. Se pueden asignar después con ' +
      '`PUT /employees/:id/branches`.',
  })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  branchIds?: string[];
}

/**
 * Los datos personales (nombre, email) NO se editan por acá: son del `User`,
 * no del empleado. Esto edita el vínculo con el negocio.
 */
export class UpdateEmployeeDto {
  @ApiPropertyOptional({ enum: ASSIGNABLE_ROLES })
  @IsOptional()
  @IsEnum(ASSIGNABLE_ROLES, {
    message: 'El rol tiene que ser PROFESSIONAL o ADMINISTRATIVE',
  })
  role?: (typeof ASSIGNABLE_ROLES)[number];

  @ApiPropertyOptional({
    description: 'Desactivar corta el acceso en el acto, sin borrar nada.',
  })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({
    nullable: true,
    example: '2026-03-01',
    pattern: DATE_ONLY_PATTERN,
  })
  @IsOptional()
  @Matches(new RegExp(DATE_ONLY_PATTERN), { message: DATE_MESSAGE })
  hiredAt?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  bio?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Transform(trim)
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true },
    { message: 'El avatar debe ser una URL http(s) válida' },
  )
  @MaxLength(500)
  avatarUrl?: string | null;
}

export class ListEmployeesQueryDto {
  @ApiPropertyOptional({
    description: 'Filtra por estado. Sin esto, vienen todos.',
  })
  @IsOptional()
  @Transform(booleanQueryParam('isActive'))
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional({ enum: EmployeeRole })
  @IsOptional()
  @IsEnum(EmployeeRole)
  role?: EmployeeRole;

  @ApiPropertyOptional({
    description: 'Solo los que trabajan en esta sucursal.',
  })
  @IsOptional()
  @IsUUID('4')
  branchId?: string;
}

/** Body de `POST /employees/activate` — endpoint público. */
export class ActivateEmployeeDto {
  @ApiProperty({
    description: 'El token del link de invitación (`<id>.<secret>`).',
  })
  @IsString()
  @MaxLength(200)
  token!: string;

  // Mismas reglas que el registro del dueño: si divergen, un empleado podría
  // elegir una contraseña que el otro flujo rechaza.
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

/** Body de `PUT /employees/:id/branches`. */
export class SetEmployeeBranchesDto {
  @ApiProperty({
    type: [String],
    description:
      'Set completo de sucursales donde trabaja. Un array vacío lo deja sin ' +
      'ninguna.',
  })
  @IsArray()
  @ArrayUnique()
  @IsUUID('4', { each: true })
  branchIds!: string[];
}
