import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsHexColor,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Respuesta de `GET/PATCH /tenants/me/branding`. */
export class TenantBrandingResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true, type: String }) logoUrl!: string | null;

  @ApiProperty({ nullable: true, type: String, example: '#7C3AED' })
  primaryColor!: string | null;

  @ApiProperty({ example: 'Peluquería Ana' }) displayName!: string;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty() updatedAt!: Date;
}

/**
 * Personalización del portal público. Todos los campos son opcionales (PATCH).
 *
 * Semántica de los campos nullables (`logoUrl`, `primaryColor`, `description`):
 * ausente = no se toca, `null` explícito = se borra. `@IsOptional()` saltea las
 * validaciones tanto para `undefined` como para `null`, así que el `null` llega
 * limpio al service, que es quien distingue los dos casos.
 */
export class UpdateTenantBrandingDto {
  @ApiPropertyOptional({
    nullable: true,
    example: 'https://cdn.agendapp.com/logos/ana.png',
    description: 'URL del logo. `null` lo borra.',
  })
  @IsOptional()
  @Transform(trim)
  @IsUrl(
    { protocols: ['http', 'https'], require_protocol: true },
    { message: 'El logo debe ser una URL http(s) válida' },
  )
  @MaxLength(500)
  logoUrl?: string | null;

  @ApiPropertyOptional({
    nullable: true,
    example: '#7C3AED',
    description: 'Color principal en hexadecimal. `null` lo borra.',
  })
  @IsOptional()
  @Transform(trim)
  @IsHexColor({ message: 'El color debe ser hexadecimal (ej. #7C3AED)' })
  @MaxLength(7)
  primaryColor?: string | null;

  @ApiPropertyOptional({ example: 'Peluquería Ana', maxLength: 120 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  displayName?: string;

  @ApiPropertyOptional({
    nullable: true,
    example: 'Cortes, color y peinados en Palermo.',
    description: 'Descripción del negocio para el portal. `null` la borra.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  description?: string | null;
}
