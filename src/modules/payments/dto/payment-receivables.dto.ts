import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AppointmentStatus } from '@prisma/client';
import { IsOptional, IsUUID, Matches } from 'class-validator';
import {
  PaginationMetaDto,
  PaginationQueryDto,
} from '../../../common/dto/pagination.dto';
import { DATE_ONLY_PATTERN } from '../../../common/utils/date-only.util';

const DATE_MESSAGE =
  'La fecha tiene que ser YYYY-MM-DD (por ejemplo 2026-09-01)';

/**
 * Tope del rango.
 *
 * `GET /payments` no lo tiene porque pagina en la base; acá el saldo de cada
 * turno se calcula fila por fila —`dueCents` no es una columna— así que el
 * rango entero pasa por memoria antes de poder recortarlo. Un trimestre entra
 * cómodo y `/reportes` mira meses.
 */
export const MAX_RECEIVABLES_RANGE_DAYS = 92;

/**
 * Los estados que pueden deber plata.
 *
 * **No es la misma lista que `BLOCKING_STATUSES`** de `availability.ts`, aunque
 * hoy tengan los mismos miembros. Ocupar un hueco en la agenda y deber plata
 * son dos preguntas distintas: si mañana aparece un estado nuevo, hay que
 * pensarlo dos veces, y compartir la constante haría que una de las dos
 * respuestas cambie sola y sin que nadie lo mire.
 *
 * Los dos cancelados quedan afuera porque un turno que no pasó no genera deuda
 * —una multa por cancelar, si el negocio la cobra, se registra como cobro y no
 * sale de acá—. `RESCHEDULED` también: la deuda se mudó al turno nuevo, y
 * contar los dos la duplicaría.
 */
export const OWING_APPOINTMENT_STATUSES = [
  AppointmentStatus.PENDING_PAYMENT,
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.ATTENDED,
  AppointmentStatus.NO_SHOW,
] as const;

/** Query de `GET /payments/receivables`. */
export class PaymentReceivablesQueryDto extends PaginationQueryDto {
  @ApiProperty({
    example: '2026-09-01',
    pattern: DATE_ONLY_PATTERN,
    description:
      'Primer día del rango, **en la zona horaria del negocio**. Incluido. ' +
      'Filtra por la fecha **del turno**, no por la de un cobro.',
  })
  @Matches(new RegExp(DATE_ONLY_PATTERN), { message: DATE_MESSAGE })
  from!: string;

  @ApiProperty({
    example: '2026-09-30',
    pattern: DATE_ONLY_PATTERN,
    description:
      'Último día del rango, **en la zona horaria del negocio**. Incluido ' +
      'entero: un turno de las 23:00 de ese día entra.',
  })
  @Matches(new RegExp(DATE_ONLY_PATTERN), { message: DATE_MESSAGE })
  to!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4')
  branchId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID('4')
  employeeId?: string;
}

export class ReceivableItemDto {
  @ApiProperty() appointmentId!: string;

  @ApiProperty({ description: 'Cuándo es (o fue) el turno.' })
  startsAt!: Date;

  @ApiProperty({ enum: OWING_APPOINTMENT_STATUSES }) status!: AppointmentStatus;

  @ApiProperty({ example: 'Laura Pérez' }) customerName!: string;
  @ApiProperty({ nullable: true, type: String }) customerPhone!: string | null;
  @ApiProperty({ example: 'Ana Gómez' }) employeeName!: string;
  @ApiProperty({ example: 'Sucursal Centro' }) branchName!: string;

  @ApiProperty({ example: 'ARS' }) currency!: string;

  @ApiProperty({ description: 'Lo que vale el turno.' })
  totalPriceCents!: number;

  @ApiProperty({ description: 'Lo que ya entró, neto de devoluciones.' })
  paidCents!: number;

  @ApiProperty({ description: 'Lo que volvió al cliente.' })
  refundedCents!: number;

  @ApiProperty({
    description:
      'Lo que falta. Siempre mayor que cero: por eso está en la lista.',
  })
  dueCents!: number;

  @ApiProperty({
    nullable: true,
    type: Number,
    description: '`null` = el turno no pide seña.',
  })
  depositAmountCents!: number | null;

  @ApiProperty({ description: 'Sin seña configurada, siempre `true`.' })
  depositCovered!: boolean;
}

/**
 * Los totales del **rango entero**, no de la página.
 *
 * Salen de la misma pasada que arma las filas, así que paginar no los mueve.
 */
export class ReceivablesTotalsDto {
  @ApiProperty({ description: 'Cuántos turnos deben algo.' })
  appointments!: number;

  @ApiProperty({ description: 'Lo que valen esos turnos, entero.' })
  totalPriceCents!: number;

  @ApiProperty({ description: 'Lo que ya entró de esos turnos.' })
  paidCents!: number;

  @ApiProperty({
    description: 'Lo que falta cobrar. Es el número del reporte.',
  })
  dueCents!: number;
}

export class PaymentReceivablesResponseDto {
  @ApiProperty({ type: [ReceivableItemDto] }) data!: ReceivableItemDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
  @ApiProperty({ type: ReceivablesTotalsDto }) totals!: ReceivablesTotalsDto;
}
