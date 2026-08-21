import { ApiProperty } from '@nestjs/swagger';
import { PaymentStatus, SubscriptionStatus } from '@prisma/client';

export class SubscriptionPlanDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Pro' }) name!: string;
  @ApiProperty({ example: 'pro' }) slug!: string;

  @ApiProperty({
    nullable: true,
    description:
      'En centavos. `null` en los planes que se cotizan con soporte: esos no ' +
      'se pueden pagar solos desde el panel.',
  })
  priceMonthlyCents!: number | null;
}

export class SubscriptionPaymentDto {
  @ApiProperty() id!: string;
  @ApiProperty() amountCents!: number;
  @ApiProperty({ example: 'ARS' }) currency!: string;
  @ApiProperty({ enum: PaymentStatus }) status!: PaymentStatus;
  @ApiProperty() periodStart!: Date;
  @ApiProperty() periodEnd!: Date;
  @ApiProperty({ nullable: true }) paidAt!: Date | null;
  @ApiProperty({ nullable: true }) failureReason!: string | null;
  @ApiProperty() createdAt!: Date;
}

/** Respuesta de `GET /tenants/me/subscription`. */
export class SubscriptionDto {
  @ApiProperty({ enum: SubscriptionStatus })
  status!: SubscriptionStatus;

  @ApiProperty({ type: SubscriptionPlanDto }) plan!: SubscriptionPlanDto;

  @ApiProperty() currentPeriodStart!: Date;

  @ApiProperty({
    description: 'Hasta cuándo está paga. Después arranca la mora.',
  })
  currentPeriodEnd!: Date;

  @ApiProperty({ description: 'Días completos de atraso. `0` si está al día.' })
  daysOverdue!: number;

  @ApiProperty({
    description:
      'Si el negocio ya no puede agendar turnos nuevos. Deber no alcanza: hay ' +
      'que pasar la ventana de gracia. Ver `graceDays`.',
  })
  blocked!: boolean;

  @ApiProperty({
    description: 'Cuántos días de atraso se toleran antes de bloquear.',
  })
  graceDays!: number;

  @ApiProperty({
    type: [SubscriptionPaymentDto],
    description: 'Del más nuevo al más viejo.',
  })
  payments!: SubscriptionPaymentDto[];
}

/** Respuesta de `POST /tenants/me/subscription/checkout`. */
export class SubscriptionCheckoutDto {
  @ApiProperty() paymentId!: string;
  @ApiProperty({ description: 'A dónde mandar al dueño a pagar.' })
  checkoutUrl!: string;
  @ApiProperty() amountCents!: number;
  @ApiProperty({ example: 'ARS' }) currency!: string;

  @ApiProperty({ description: 'Desde cuándo cubre el pago.' })
  periodStart!: Date;

  @ApiProperty({ description: 'Hasta cuándo.' })
  periodEnd!: Date;

  @ApiProperty({
    description:
      'Si se devolvió un checkout que ya existía. Pedirlo dos veces no genera ' +
      'dos cobros del mismo mes.',
  })
  reused!: boolean;
}
