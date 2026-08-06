import { ApiProperty } from '@nestjs/swagger';
import { EmployeeRole, SubscriptionStatus } from '@prisma/client';

export class MeUserDto {
  @ApiProperty() id!: string;
  @ApiProperty() email!: string;
  @ApiProperty() firstName!: string;
  @ApiProperty() lastName!: string;
  @ApiProperty({ nullable: true, type: String }) phone!: string | null;
  @ApiProperty({ nullable: true, type: Date }) emailVerifiedAt!: Date | null;
}

export class MeTenantDto {
  @ApiProperty() id!: string;
  @ApiProperty() businessName!: string;
  @ApiProperty() slug!: string;
  @ApiProperty() timezone!: string;
  @ApiProperty() currency!: string;
  @ApiProperty() language!: string;
  @ApiProperty({ enum: SubscriptionStatus })
  subscriptionStatus!: SubscriptionStatus;
  @ApiProperty({ nullable: true, type: Date }) trialEndsAt!: Date | null;
}

export class MeEmployeeDto {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: EmployeeRole }) role!: EmployeeRole;
  @ApiProperty() isOwner!: boolean;
}

/** Respuesta de `GET /auth/me`: quién sos, en qué negocio y con qué rol. */
export class MeResponseDto {
  @ApiProperty({ type: MeUserDto }) user!: MeUserDto;
  @ApiProperty({ type: MeTenantDto }) tenant!: MeTenantDto;
  @ApiProperty({ type: MeEmployeeDto }) employee!: MeEmployeeDto;
}
