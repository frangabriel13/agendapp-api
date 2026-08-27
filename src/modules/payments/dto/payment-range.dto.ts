import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  AppointmentPaymentType,
  PaymentMethod,
  PaymentStatus,
} from '@prisma/client';
import { IsEnum, IsIn, IsOptional, IsUUID, Matches } from 'class-validator';
import {
  PaginationMetaDto,
  PaginationQueryDto,
} from '../../../common/dto/pagination.dto';
import { DATE_ONLY_PATTERN } from '../../../common/utils/date-only.util';
import { PaymentRecordedByDto } from './payment.dto';

const DATE_MESSAGE =
  'La fecha tiene que ser YYYY-MM-DD (por ejemplo 2026-09-01)';

/**
 * Los únicos estados que pueden caer en un rango.
 *
 * El filtro es por `paidAt`, y un pago `PENDING` o `FAILED` lo tiene en null:
 * **no puede entrar nunca**. Aceptarlos y devolver una lista vacía sería dejar
 * que el malentendido pase por respuesta válida — este endpoint informa plata
 * liquidada, no el estado de cobranza del mes. Un 400 lo dice a tiempo.
 */
export const SETTLED_PAYMENT_STATUSES = [
  PaymentStatus.SUCCEEDED,
  PaymentStatus.REFUNDED,
] as const;

export type SettledPaymentStatus = (typeof SETTLED_PAYMENT_STATUSES)[number];

/** Query de `GET /payments`. */
export class PaymentRangeQueryDto extends PaginationQueryDto {
  @ApiProperty({
    example: '2026-09-01',
    pattern: DATE_ONLY_PATTERN,
    description:
      'Primer día del rango, **en la zona horaria del negocio**. Incluido.',
  })
  @Matches(new RegExp(DATE_ONLY_PATTERN), { message: DATE_MESSAGE })
  from!: string;

  @ApiProperty({
    example: '2026-09-30',
    pattern: DATE_ONLY_PATTERN,
    description:
      'Último día del rango, **en la zona horaria del negocio**. Incluido ' +
      'entero: un pago de las 23:50 de ese día entra.',
  })
  @Matches(new RegExp(DATE_ONLY_PATTERN), { message: DATE_MESSAGE })
  to!: string;

  @ApiPropertyOptional({
    enum: SETTLED_PAYMENT_STATUSES,
    description:
      '`PENDING` y `FAILED` no se aceptan: no tienen fecha de acreditación, ' +
      'así que no pueden estar en un rango.',
  })
  @IsOptional()
  // `IsIn` y no `IsEnum`: el enum tiene dos valores que acá no significan nada.
  @IsIn(SETTLED_PAYMENT_STATUSES, {
    message: `status tiene que ser uno de: ${SETTLED_PAYMENT_STATUSES.join(', ')}`,
  })
  status?: SettledPaymentStatus;

  @ApiPropertyOptional({ enum: PaymentMethod })
  @IsOptional()
  @IsEnum(PaymentMethod)
  paymentMethod?: PaymentMethod;

  @ApiPropertyOptional({ description: 'Cobros de turnos de esta sucursal.' })
  @IsOptional()
  @IsUUID()
  branchId?: string;

  @ApiPropertyOptional({
    description:
      'Cobros de turnos de este profesional. **Es quién atiende el turno**, ' +
      'no quién registró el pago: eso último es `recordedBy`.',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;
}

/** De qué turno era el cobro. Lo mínimo para reconocerlo en una grilla. */
export class PaymentRangeAppointmentDto {
  @ApiProperty() id!: string;
  @ApiProperty() startsAt!: Date;
  @ApiProperty({ example: 'Lucía Fernández' }) customerName!: string;
  @ApiProperty({ example: 'Ana Gómez' }) employeeName!: string;
  @ApiProperty({ example: 'Sucursal Centro' }) branchName!: string;
}

export class PaymentRangeItemDto {
  @ApiProperty() id!: string;
  @ApiProperty() amountCents!: number;
  @ApiProperty({ example: 'ARS' }) currency!: string;

  @ApiProperty({
    enum: AppointmentPaymentType,
    description: '`REFUND` es plata que volvió. Se guarda en positivo.',
  })
  paymentType!: AppointmentPaymentType;

  @ApiProperty({ enum: PaymentMethod }) paymentMethod!: PaymentMethod;

  @ApiProperty({
    enum: SETTLED_PAYMENT_STATUSES,
    description:
      '`REFUNDED` es un cobro que el proveedor revirtió entero: sigue en la ' +
      'lista con su monto original, pero no suma al neto.',
  })
  status!: SettledPaymentStatus;

  @ApiProperty({
    description: 'Cuándo entró la plata. Es por lo que se filtra.',
  })
  paidAt!: Date;

  @ApiProperty({ nullable: true }) notes!: string | null;

  @ApiProperty({
    type: PaymentRecordedByDto,
    nullable: true,
    description: 'Quién lo cargó a mano. `null` = lo pagó el cliente online.',
  })
  recordedBy!: PaymentRecordedByDto | null;

  @ApiProperty({ type: PaymentRangeAppointmentDto })
  appointment!: PaymentRangeAppointmentDto;
}

/**
 * Los totales del **rango entero**, no de la página que se está mirando.
 *
 * Salen de una consulta aparte agrupada en la base: paginar no los mueve, y el
 * panel no tiene que ir página por página sumando.
 */
export class PaymentRangeTotalsDto {
  @ApiProperty({ description: 'Lo que se cobró, sin descontar devoluciones.' })
  chargedCents!: number;

  @ApiProperty({
    description:
      'Lo que volvió al cliente: las devoluciones propias más los cobros que ' +
      'el proveedor revirtió.',
  })
  refundedCents!: number;

  @ApiProperty({
    description:
      'Lo que quedó: cobrado menos devoluciones. **Este es "cuánto entró".**',
  })
  netCents!: number;
}

/** Respuesta de `GET /payments`. */
export class PaymentRangeResponseDto {
  @ApiProperty({ type: [PaymentRangeItemDto] })
  data!: PaymentRangeItemDto[];

  @ApiProperty({ type: PaginationMetaDto })
  meta!: PaginationMetaDto;

  @ApiProperty({ type: PaymentRangeTotalsDto })
  totals!: PaymentRangeTotalsDto;
}
