import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsISO4217CurrencyCode,
  IsOptional,
  IsString,
  IsTimeZone,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { trim } from '../../../common/utils/trim.transform';

const upperTrim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toUpperCase() : value;

const lowerTrim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

/**
 * Campos editables del negocio. Todos opcionales: es un PATCH.
 *
 * El `slug` queda deliberadamente afuera: es la URL pública del portal de
 * reservas (Fase 7), así que cambiarlo rompe links ya compartidos. Cuando haga
 * falta, va a ser un endpoint propio que valide reservados, duplicados y —
 * idealmente— deje un redirect del slug viejo.
 */
export class UpdateTenantDto {
  @ApiPropertyOptional({ example: 'Peluquería Ana', maxLength: 120 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  businessName?: string;

  @ApiPropertyOptional({
    example: 'America/Argentina/Buenos_Aires',
    description:
      'Zona horaria IANA. Define cómo se muestran los turnos: en la base todo va en UTC.',
  })
  @IsOptional()
  @Transform(trim)
  @IsTimeZone({ message: 'La zona horaria no es una zona IANA válida' })
  timezone?: string;

  @ApiPropertyOptional({ example: 'ARS', description: 'Código ISO 4217.' })
  @IsOptional()
  @Transform(upperTrim)
  @IsISO4217CurrencyCode({
    message: 'La moneda debe ser un código ISO 4217 (ej. ARS, USD)',
  })
  currency?: string;

  @ApiPropertyOptional({ example: 'es', maxLength: 5 })
  @IsOptional()
  @Transform(lowerTrim)
  @IsString()
  @MaxLength(5)
  @Matches(/^[a-z]{2}(-[a-z]{2})?$/, {
    message: 'El idioma debe tener el formato "es" o "es-ar"',
  })
  language?: string;
}
