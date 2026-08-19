import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  AppointmentSource,
  AppointmentStatus,
  CancellationRefundType,
} from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { arrayQueryParam } from '../../../common/utils/array-query.transform';
import { DATE_ONLY_PATTERN } from '../../../common/utils/date-only.util';
import { trim } from '../../../common/utils/trim.transform';

const DATE_MESSAGE =
  'La fecha tiene que ser YYYY-MM-DD (por ejemplo 2026-09-01)';

/** Tope de servicios en un mismo turno. Más que esto no es un turno, es un día. */
export const MAX_SERVICES_PER_APPOINTMENT = 10;

/** Cuántos días puede abarcar una consulta de agenda. Un trimestre alcanza. */
export const MAX_RANGE_DAYS = 92;

/**
 * Los estados a los que se puede mover un turno a mano. `RESCHEDULED` no está:
 * a ese se llega con `POST /appointments/:id/reschedule`, que además crea el
 * turno de reemplazo y los deja enlazados.
 */
export const SETTABLE_STATUSES = [
  AppointmentStatus.CONFIRMED,
  AppointmentStatus.ATTENDED,
  AppointmentStatus.NO_SHOW,
  AppointmentStatus.CANCELED_BY_CUSTOMER,
  AppointmentStatus.CANCELED_BY_BUSINESS,
] as const;

export class AppointmentPartyDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Lucía Fernández' }) name!: string;
}

export class AppointmentCustomerDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'María' }) firstName!: string;

  @ApiProperty({ nullable: true, type: String, example: 'González' })
  lastName!: string | null;

  @ApiProperty({ example: '+54 9 11 5555-1234' }) phone!: string;
}

export class AppointmentServiceDto {
  @ApiProperty() serviceId!: string;
  @ApiProperty({ example: 'Corte de dama' }) name!: string;

  @ApiProperty({
    example: 45,
    description: 'Lo que duraba el servicio **cuando se reservó**.',
  })
  durationMinutes!: number;

  @ApiProperty({
    example: 1_500_000,
    description: 'Lo que salía **cuando se reservó**, en centavos.',
  })
  priceCents!: number;
}

export class AppointmentResourceDto {
  @ApiProperty() resourceId!: string;
  @ApiProperty({ example: 'Sala de color' }) name!: string;
}

export class AppointmentResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ type: AppointmentPartyDto }) branch!: AppointmentPartyDto;
  @ApiProperty({ type: AppointmentPartyDto }) employee!: AppointmentPartyDto;
  @ApiProperty({ type: AppointmentCustomerDto })
  customer!: AppointmentCustomerDto;

  @ApiProperty({ example: '2026-09-07T12:00:00.000Z' }) startsAt!: Date;

  @ApiProperty({
    example: '2026-09-07T12:55:00.000Z',
    description: 'Incluye el buffer: es lo que el profesional queda ocupado.',
  })
  endsAt!: Date;

  @ApiProperty({ enum: AppointmentStatus }) status!: AppointmentStatus;
  @ApiProperty({ enum: AppointmentSource }) createdVia!: AppointmentSource;

  @ApiProperty({ example: 1_500_000 }) totalPriceCents!: number;

  @ApiProperty({ nullable: true, type: Number })
  depositAmountCents!: number | null;

  @ApiProperty() depositPaid!: boolean;

  @ApiProperty({ nullable: true, type: String }) notes!: string | null;

  @ApiProperty({ type: [AppointmentServiceDto] })
  services!: AppointmentServiceDto[];

  @ApiProperty({ type: [AppointmentResourceDto] })
  resources!: AppointmentResourceDto[];

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'El turno al que este reemplazó.',
  })
  rescheduledFromId!: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'El turno que reemplazó a este.',
  })
  rescheduledToId!: string | null;

  @ApiProperty({ nullable: true, type: Date }) canceledAt!: Date | null;

  @ApiProperty({ nullable: true, type: String })
  cancellationReason!: string | null;

  @ApiProperty({ nullable: true, type: String })
  recurrenceGroupId!: string | null;

  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class CreateAppointmentDto {
  @ApiProperty() @IsUUID() branchId!: string;
  @ApiProperty() @IsUUID() employeeId!: string;
  @ApiProperty() @IsUUID() customerId!: string;

  @ApiProperty({
    type: [String],
    minItems: 1,
    maxItems: MAX_SERVICES_PER_APPOINTMENT,
    description:
      'Uno o varios servicios seguidos con el mismo profesional. La duración ' +
      'del turno es la suma de todos, buffers incluidos.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_SERVICES_PER_APPOINTMENT)
  @IsUUID(undefined, { each: true })
  serviceIds!: string[];

  @ApiProperty({
    example: '2026-09-07T12:00:00.000Z',
    description:
      'Instante en que arranca, en UTC. El fin lo calcula el servidor con la ' +
      'duración de los servicios.',
  })
  @IsISO8601({ strict: true })
  startsAt!: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

/** Lo único editable de un turno agendado. Mover el horario es reprogramar. */
export class UpdateAppointmentDto {
  @ApiPropertyOptional({ nullable: true, maxLength: 2000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  notes?: string | null;
}

export class ChangeAppointmentStatusDto {
  @ApiProperty({
    enum: SETTABLE_STATUSES,
    description:
      'A `rescheduled` no se llega por acá: eso es `POST /:id/reschedule`.',
  })
  @IsEnum(SETTABLE_STATUSES, {
    message:
      'El estado tiene que ser CONFIRMED, ATTENDED, NO_SHOW, ' +
      'CANCELED_BY_CUSTOMER o CANCELED_BY_BUSINESS',
  })
  status!: (typeof SETTABLE_STATUSES)[number];

  @ApiPropertyOptional({
    maxLength: 500,
    description: 'Solo tiene sentido al cancelar.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  cancellationReason?: string;
}

export class RescheduleAppointmentDto {
  @ApiProperty({
    example: '2026-09-08T14:00:00.000Z',
    description: 'El nuevo horario de arranque.',
  })
  @IsISO8601({ strict: true })
  startsAt!: string;

  @ApiPropertyOptional({
    description:
      'Si el turno además cambia de profesional. Si se omite, sigue el mismo.',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class RefundDecisionDto {
  @ApiProperty({ enum: CancellationRefundType })
  type!: CancellationRefundType;

  @ApiProperty({
    example: 500_000,
    description: 'Cuánto corresponde devolver, en centavos.',
  })
  amountCents!: number;

  @ApiProperty({
    description: 'Si canceló con la antelación que pide el negocio.',
  })
  withinPolicy!: boolean;

  @ApiProperty({
    description: 'Explicación lista para mostrarle a la persona.',
  })
  reason!: string;
}

export class ChangeStatusResultDto {
  @ApiProperty({ type: AppointmentResponseDto })
  appointment!: AppointmentResponseDto;

  @ApiProperty({
    type: RefundDecisionDto,
    nullable: true,
    description:
      'Solo viene al cancelar; en el resto de los cambios es `null`. ' +
      '**No mueve plata**: dice qué corresponde según la política del ' +
      'negocio. La devolución real llega con los pagos (Fase 6).',
  })
  refund!: RefundDecisionDto | null;
}

/**
 * Query de `GET /appointments`. Es un rango de fechas y no una paginación
 * porque quien lo consume es un calendario: se pide "esta semana", no "página 3".
 */
export class ListAppointmentsQueryDto {
  @ApiProperty({
    example: '2026-09-07',
    pattern: DATE_ONLY_PATTERN,
    description: 'Desde, inclusive. Día del calendario en la zona del negocio.',
  })
  @Matches(new RegExp(DATE_ONLY_PATTERN), { message: DATE_MESSAGE })
  from!: string;

  @ApiProperty({
    example: '2026-09-13',
    pattern: DATE_ONLY_PATTERN,
    description: `Hasta, inclusive. Como mucho ${MAX_RANGE_DAYS} días después de \`from\`.`,
  })
  @Matches(new RegExp(DATE_ONLY_PATTERN), { message: DATE_MESSAGE })
  to!: string;

  @ApiPropertyOptional() @IsOptional() @IsUUID() branchId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() employeeId?: string;
  @ApiPropertyOptional() @IsOptional() @IsUUID() customerId?: string;

  @ApiPropertyOptional({
    enum: AppointmentStatus,
    isArray: true,
    description:
      'Si se omite vienen todos, cancelados incluidos. Se puede repetir: ' +
      '`?status=CONFIRMED&status=PENDING_PAYMENT`.',
  })
  @IsOptional()
  @Transform(arrayQueryParam)
  @IsEnum(AppointmentStatus, { each: true })
  status?: AppointmentStatus[];
}
