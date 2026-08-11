import { ApiProperty } from '@nestjs/swagger';
import { SubscriptionStatus, SupportLevel } from '@prisma/client';

/** Resumen del plan contratado: el front lo usa para mostrar y bloquear límites. */
export class TenantPlanDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Básico' }) name!: string;
  @ApiProperty({ example: 'basico' }) slug!: string;

  @ApiProperty({
    nullable: true,
    type: Number,
    description: '`null` = a medida / sin límite (plan Empresa).',
  })
  maxEmployees!: number | null;

  @ApiProperty({ nullable: true, type: Number })
  maxBranches!: number | null;

  @ApiProperty() includesClinicRecords!: boolean;
  @ApiProperty() includesResources!: boolean;
  @ApiProperty({ enum: SupportLevel }) supportLevel!: SupportLevel;
}

/** Respuesta de `GET /tenants/me` y `PATCH /tenants/me`. */
export class TenantResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Peluquería Ana' }) businessName!: string;

  @ApiProperty({
    example: 'peluqueria-ana',
    description:
      'Identificador público del negocio (portal de reservas). Hoy no es editable.',
  })
  slug!: string;

  @ApiProperty({ example: 'America/Argentina/Buenos_Aires' }) timezone!: string;
  @ApiProperty({ example: 'ARS' }) currency!: string;
  @ApiProperty({ example: 'es' }) language!: string;

  @ApiProperty({ enum: SubscriptionStatus })
  subscriptionStatus!: SubscriptionStatus;

  @ApiProperty({ nullable: true, type: Date }) trialEndsAt!: Date | null;
  @ApiProperty({ type: TenantPlanDto }) plan!: TenantPlanDto;
  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}
