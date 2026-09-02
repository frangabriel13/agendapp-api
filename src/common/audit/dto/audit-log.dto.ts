import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import {
  PaginationMetaDto,
  PaginationQueryDto,
} from '../../dto/pagination.dto';
import { DATE_ONLY_PATTERN } from '../../utils/date-only.util';

/**
 * Tope del rango consultable, en días.
 *
 * `audit_logs` no se borra nunca —es el punto— así que sin tope una consulta
 * podría barrer años. El mismo número que usan los reportes de pagos, para que
 * el front no tenga que recordar dos.
 */
export const MAX_AUDIT_RANGE_DAYS = 92;

const DATE_MESSAGE =
  'La fecha tiene que ser YYYY-MM-DD (por ejemplo 2026-09-02)';

export class AuditActorDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Lucía' }) firstName!: string;
  @ApiProperty({ example: 'Fernández' }) lastName!: string;
  @ApiProperty({ example: 'lucia@peluqueria.com' }) email!: string;
}

export class AuditLogResponseDto {
  @ApiProperty() id!: string;

  @ApiProperty({
    type: AuditActorDto,
    nullable: true,
    description:
      '`null` cuando no había nadie identificado: un login que no entró, o ' +
      'una acción del sistema.',
  })
  user!: AuditActorDto | null;

  @ApiProperty({ example: 'canceled' }) action!: string;
  @ApiProperty({ example: 'appointment' }) entityType!: string;

  @ApiProperty({ nullable: true, type: String })
  entityId!: string | null;

  @ApiProperty({
    nullable: true,
    type: Object,
    description:
      'Con qué datos se pidió, **ya censurado**: contraseñas, tokens y firmas ' +
      'nunca llegan a guardarse. No es un diff contra el estado anterior.',
  })
  changes!: Record<string, unknown> | null;

  @ApiProperty({ nullable: true, type: String, example: '190.2.3.4' })
  ipAddress!: string | null;

  @ApiProperty({ nullable: true, type: String })
  userAgent!: string | null;

  @ApiProperty() createdAt!: Date;
}

export class PaginatedAuditLogsDto {
  @ApiProperty({ type: [AuditLogResponseDto] }) data!: AuditLogResponseDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
}

export class ListAuditLogsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    example: 'appointment',
    description: 'Sobre qué tipo de cosa. Junto con `entityId` usa el índice.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  entityType?: string;

  @ApiPropertyOptional({ description: 'La entidad puntual.' })
  @IsOptional()
  @IsUUID()
  entityId?: string;

  @ApiPropertyOptional({ example: 'canceled' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  action?: string;

  @ApiPropertyOptional({ description: 'Todo lo que hizo una persona.' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({
    example: '2026-09-01',
    pattern: DATE_ONLY_PATTERN,
    description: 'Día del calendario **del negocio**, inclusive.',
  })
  @IsOptional()
  @Matches(new RegExp(DATE_ONLY_PATTERN), { message: DATE_MESSAGE })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-09-30',
    pattern: DATE_ONLY_PATTERN,
    description: 'Inclusive: el día entero, hasta las 23:59 del negocio.',
  })
  @IsOptional()
  @Matches(new RegExp(DATE_ONLY_PATTERN), { message: DATE_MESSAGE })
  to?: string;
}
