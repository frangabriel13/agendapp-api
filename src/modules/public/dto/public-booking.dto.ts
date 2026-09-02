import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEmail,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { lowercaseTrim, trim } from '../../../common/utils/trim.transform';
import { MAX_SERVICES_PER_APPOINTMENT } from '../../appointments/dto/appointment.dto';
import { PHONE_MESSAGE, PHONE_PATTERN } from '../../customers/dto/customer.dto';

/**
 * Quién reserva. **Es lo mínimo para poder atenderla y avisarle**, y nada más:
 * ni fecha de nacimiento ni notas, que son cosas que el negocio carga en la
 * ficha, no que un desconocido escribe en un formulario.
 *
 * El teléfono usa el mismo patrón que el alta de clientes del panel
 * (`PHONE_PATTERN`, importado y no copiado): dos reglas distintas para el mismo
 * dato terminarían aceptando por un lado lo que el otro rechaza.
 */
export class PublicBookingCustomerDto {
  @ApiProperty({ example: 'María', maxLength: 100 })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  firstName!: string;

  @ApiPropertyOptional({ example: 'González', maxLength: 100 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  lastName?: string | null;

  @ApiProperty({
    example: '+54 9 11 5555-1234',
    pattern: PHONE_PATTERN,
    description:
      'Es lo que identifica a la persona. Si ya es clienta del negocio se usa ' +
      'su ficha; si no, se crea una. **La respuesta es idéntica en los dos ' +
      'casos**, a propósito: si se distinguieran, cualquiera podría averiguar ' +
      'quién es clienta probando números.',
  })
  @Transform(trim)
  @Matches(new RegExp(PHONE_PATTERN), { message: PHONE_MESSAGE })
  phone!: string;

  @ApiPropertyOptional({
    description:
      'Sin esto no se le puede mandar la confirmación ni el link de pago; el ' +
      'turno igual se agenda.',
  })
  @IsOptional()
  @Transform(lowercaseTrim)
  @IsEmail({}, { message: 'El email no tiene un formato válido' })
  @MaxLength(255)
  email?: string | null;
}

export class CreatePublicBookingDto {
  @ApiProperty({ description: 'De `GET /public/:slug/branches`.' })
  @IsUUID()
  branchId!: string;

  @ApiPropertyOptional({
    description:
      'Con quién. **Si se omite, lo elige el servidor** entre los que tienen ' +
      'ese hueco libre — es el caso "cualquiera" del portal. Elegir a mano es ' +
      'mandar uno de los `employees[]` que devolvió la disponibilidad.',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;

  @ApiProperty({
    type: [String],
    minItems: 1,
    maxItems: MAX_SERVICES_PER_APPOINTMENT,
    description:
      'Los mismos con los que se consultó la disponibilidad: la duración del ' +
      'turno es la suma de todos.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_SERVICES_PER_APPOINTMENT)
  @IsUUID(undefined, { each: true })
  serviceIds!: string[];

  @ApiProperty({
    example: '2026-09-07T12:00:00.000Z',
    description:
      'El `startsAt` de uno de los slots que devolvió la disponibilidad, tal ' +
      'cual vino. Mandar otro instante no es un error de validación: es un ' +
      '409, porque el hueco no existe.',
  })
  @IsISO8601({ strict: true })
  startsAt!: string;

  @ApiProperty({ type: PublicBookingCustomerDto })
  @IsObject()
  @ValidateNested()
  @Type(() => PublicBookingCustomerDto)
  customer!: PublicBookingCustomerDto;

  @ApiPropertyOptional({
    maxLength: 500,
    description:
      'Lo que quiera aclarar quien reserva. Más corto que el del panel: acá ' +
      'escribe alguien de afuera y el campo va a parar a la agenda del negocio.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/** Un servicio del turno, con lo que la clienta necesita ver: qué y cuánto. */
export class PublicBookedServiceDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Corte de pelo' }) name!: string;
  @ApiProperty({ example: 45 }) durationMinutes!: number;
  @ApiProperty({ example: 850000 }) priceCents!: number;
}

/** Lo que falta pagar para que el turno quede tomado. */
export class PublicBookingDepositDto {
  @ApiProperty({ example: 300000 }) amountCents!: number;
  @ApiProperty({ example: 'ARS' }) currency!: string;

  @ApiProperty({
    example: 'https://www.mercadopago.com/checkout/v1/redirect?pref_id=...',
    description: 'A dónde mandar a la clienta. Es un link de un solo turno.',
  })
  checkoutUrl!: string;
}

/**
 * El comprobante de la reserva.
 *
 * ⚠️ **No devuelve nada de la clienta.** Ni el nombre guardado en la ficha, ni
 * el mail, ni si ya existía. Es el mismo motivo por el que el formulario acepta
 * un teléfono que ya está cargado sin decirlo: cualquier diferencia en la
 * respuesta convierte este endpoint en un buscador de clientela ajena. Quien
 * reservó ya sabe sus propios datos.
 */
export class PublicBookingResponseDto {
  @ApiProperty() appointmentId!: string;

  @ApiProperty({ example: '2026-09-07T12:00:00.000Z' })
  startsAt!: Date;

  @ApiProperty({ example: '2026-09-07T12:45:00.000Z' })
  endsAt!: Date;

  @ApiProperty({
    example: 'pending_payment',
    description:
      '`pending_payment` mientras falte la seña, `confirmed` cuando el turno ' +
      'ya está tomado.',
  })
  status!: string;

  @ApiProperty({ example: 'Sucursal Centro' }) branchName!: string;
  @ApiProperty({ example: 'Lucía Fernández' }) employeeName!: string;

  @ApiProperty({ type: [PublicBookedServiceDto] })
  services!: PublicBookedServiceDto[];

  @ApiProperty({ example: 850000 }) totalPriceCents!: number;
  @ApiProperty({ example: 'ARS' }) currency!: string;

  @ApiProperty({
    type: PublicBookingDepositDto,
    nullable: true,
    description:
      '`null` cuando no hay nada que pagar por adelantado. Cuando viene, el ' +
      'turno **todavía no está tomado**: se libera solo si la seña no entra.',
  })
  deposit!: PublicBookingDepositDto | null;
}
