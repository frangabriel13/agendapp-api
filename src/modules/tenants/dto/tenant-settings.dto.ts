import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { CancellationRefundType } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

/** Tope de la ventana de cancelación: 30 días. Más que eso es un error de carga. */
const MAX_CANCELLATION_POLICY_HOURS = 720;

/** Tope del buffer entre turnos: 8 horas. */
const MAX_BUFFER_MINUTES = 480;

/** Respuesta de `GET/PATCH /tenants/me/settings`. */
export class TenantSettingsResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 24 }) cancellationPolicyHours!: number;

  @ApiProperty({ enum: CancellationRefundType })
  cancellationRefundType!: CancellationRefundType;

  @ApiProperty({ nullable: true, type: Number, example: 50 })
  cancellationRefundPercentage!: number | null;

  @ApiProperty() requireDepositForBooking!: boolean;
  @ApiProperty({ example: 0 }) defaultBufferMinutes!: number;
  @ApiProperty() updatedAt!: Date;
}

/**
 * Configuración operativa del negocio. La consumen las Fases 5 (turnos) y 6
 * (pagos), así que los valores raros se atajan acá y con CHECK constraints en
 * la base — no cuando falle un turno.
 */
export class UpdateTenantSettingsDto {
  @ApiPropertyOptional({
    example: 24,
    minimum: 0,
    maximum: MAX_CANCELLATION_POLICY_HOURS,
    description:
      'Horas de anticipación con las que el cliente puede cancelar sin penalidad.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_CANCELLATION_POLICY_HOURS)
  cancellationPolicyHours?: number;

  @ApiPropertyOptional({ enum: CancellationRefundType })
  @IsOptional()
  @IsEnum(CancellationRefundType)
  cancellationRefundType?: CancellationRefundType;

  @ApiPropertyOptional({
    example: 50,
    minimum: 0,
    maximum: 100,
    description:
      'Porcentaje a devolver. Obligatorio si el tipo de reembolso es `PARTIAL`; ' +
      'con cualquier otro tipo se guarda en `null`.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(100)
  cancellationRefundPercentage?: number;

  @ApiPropertyOptional({
    description:
      'Si está en true, los turnos nacen en `pending_payment` hasta que se pague la seña.',
  })
  @IsOptional()
  @IsBoolean()
  requireDepositForBooking?: boolean;

  @ApiPropertyOptional({
    example: 10,
    minimum: 0,
    maximum: MAX_BUFFER_MINUTES,
    description:
      'Minutos de colchón entre turnos cuando el servicio no define uno.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(MAX_BUFFER_MINUTES)
  defaultBufferMinutes?: number;
}
