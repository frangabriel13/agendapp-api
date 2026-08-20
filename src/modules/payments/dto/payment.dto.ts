import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  AppointmentPaymentType,
  PaymentMethod,
  PaymentStatus,
} from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';
import { trim } from '../../../common/utils/trim.transform';

/**
 * Los tipos que se pueden cobrar online. `REFUND` queda afuera a propósito: una
 * devolución no se cobra con un checkout, se emite. Cuando exista la devolución
 * automática (falta), va a ser su propio endpoint.
 */
export const CHECKOUT_PAYMENT_TYPES = [
  AppointmentPaymentType.DEPOSIT,
  AppointmentPaymentType.FULL,
  AppointmentPaymentType.REMAINDER,
] as const;

export type CheckoutPaymentType = (typeof CHECKOUT_PAYMENT_TYPES)[number];

/**
 * Los métodos que se cargan a mano. `MERCADOPAGO` queda afuera: ese pago lo
 * crea el checkout y lo confirma el webhook. Dejarlo entrar por acá permitiría
 * marcar como cobrado algo que nunca se cobró.
 */
export const MANUAL_PAYMENT_METHODS = [
  PaymentMethod.CASH,
  PaymentMethod.TRANSFER,
  PaymentMethod.OTHER,
] as const;

export type ManualPaymentMethod = (typeof MANUAL_PAYMENT_METHODS)[number];

/** Body de `POST /appointments/:id/payments/checkout`. */
export class CreateCheckoutDto {
  @ApiPropertyOptional({
    enum: CHECKOUT_PAYMENT_TYPES,
    description:
      'Qué se cobra. Si no se manda, se deduce: la seña cuando el turno tiene ' +
      'una y todavía no está cubierta, y el saldo en cualquier otro caso.',
  })
  @IsOptional()
  // `IsIn` y no `IsEnum`: el enum incluye `REFUND`, que acá no se puede cobrar.
  @IsIn(CHECKOUT_PAYMENT_TYPES, {
    message: `paymentType tiene que ser uno de: ${CHECKOUT_PAYMENT_TYPES.join(', ')}`,
  })
  paymentType?: CheckoutPaymentType;
}

/** Body de `POST /appointments/:id/payments/manual`. */
export class RecordManualPaymentDto {
  @ApiProperty({ example: 30000, minimum: 1, description: 'En centavos.' })
  @IsInt()
  @Min(1, { message: 'El monto tiene que ser mayor a cero' })
  amountCents!: number;

  @ApiProperty({
    enum: AppointmentPaymentType,
    description:
      'Incluye `REFUND`: así se registra la plata que se devolvió en el mostrador.',
  })
  @IsEnum(AppointmentPaymentType)
  paymentType!: AppointmentPaymentType;

  @ApiProperty({ enum: MANUAL_PAYMENT_METHODS })
  // `IsIn` y no `IsEnum`: `MERCADOPAGO` queda afuera. Ese pago lo crea el
  // checkout y lo confirma el webhook; dejarlo entrar por acá permitiría marcar
  // como cobrado algo que nunca se cobró.
  @IsIn(MANUAL_PAYMENT_METHODS, {
    message: `paymentMethod tiene que ser uno de: ${MANUAL_PAYMENT_METHODS.join(', ')}`,
  })
  paymentMethod!: ManualPaymentMethod;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export class PaymentRecordedByDto {
  @ApiProperty() id!: string;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
}

export class PaymentResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() amountCents!: number;
  @ApiProperty({ example: 'ARS' }) currency!: string;
  @ApiProperty({ enum: AppointmentPaymentType })
  paymentType!: AppointmentPaymentType;
  @ApiProperty({ enum: PaymentMethod }) paymentMethod!: PaymentMethod;
  @ApiProperty({ enum: PaymentStatus }) status!: PaymentStatus;
  @ApiProperty({ nullable: true }) notes!: string | null;
  @ApiProperty({ nullable: true }) failureReason!: string | null;

  @ApiProperty({
    nullable: true,
    description: 'El link de pago, mientras el cobro online siga pendiente.',
  })
  checkoutUrl!: string | null;

  @ApiProperty({ nullable: true }) paidAt!: Date | null;
  @ApiProperty() createdAt!: Date;

  @ApiProperty({
    type: PaymentRecordedByDto,
    nullable: true,
    description: 'Quién lo cargó a mano. `null` = lo pagó el cliente online.',
  })
  recordedBy!: PaymentRecordedByDto | null;
}

export class AppointmentBalanceDto {
  @ApiProperty() totalPriceCents!: number;
  @ApiProperty({ nullable: true }) depositAmountCents!: number | null;

  @ApiProperty({
    description:
      'Lo que quedó en la caja: entradas acreditadas menos devoluciones. ' +
      'Puede ser negativo si se devolvió más de lo cobrado.',
  })
  paidCents!: number;

  @ApiProperty() refundedCents!: number;

  @ApiProperty({ description: 'Lo que falta cobrar. Nunca negativo.' })
  dueCents!: number;

  @ApiProperty({ description: 'Sin seña configurada, siempre `true`.' })
  depositCovered!: boolean;

  @ApiProperty() fullyPaid!: boolean;
}

/** Respuesta de `GET /appointments/:id/payments`. */
export class AppointmentPaymentsDto {
  @ApiProperty({ type: AppointmentBalanceDto })
  balance!: AppointmentBalanceDto;

  @ApiProperty({ type: [PaymentResponseDto] })
  payments!: PaymentResponseDto[];
}

/** Respuesta de `POST /appointments/:id/payments/checkout`. */
export class CheckoutResponseDto {
  @ApiProperty({
    description: 'La fila de pago que se creó, en estado pendiente.',
  })
  paymentId!: string;

  @ApiProperty({ description: 'A dónde mandar al cliente a pagar.' })
  checkoutUrl!: string;

  @ApiProperty() amountCents!: number;
  @ApiProperty({ example: 'ARS' }) currency!: string;
  @ApiProperty({ enum: CHECKOUT_PAYMENT_TYPES })
  paymentType!: AppointmentPaymentType;

  @ApiProperty({
    description:
      'Si se devolvió un checkout que ya existía en vez de crear otro. Pedir ' +
      'dos veces el mismo cobro no genera dos links.',
  })
  reused!: boolean;
}

/**
 * Respuesta del webhook. No la lee nadie del negocio —Mercado Pago solo mira el
 * código HTTP— pero deja en el log qué se hizo con cada aviso.
 */
export class WebhookResultDto {
  @ApiProperty({
    enum: ['applied', 'ignored', 'unknown_payment'],
    description:
      '`ignored` = el aviso no era de un pago. `unknown_payment` = el pago no ' +
      'es nuestro o ya no existe. Los dos se contestan 200 igual: reintentarlo ' +
      'no cambiaría nada.',
  })
  result!: 'applied' | 'ignored' | 'unknown_payment';
}
