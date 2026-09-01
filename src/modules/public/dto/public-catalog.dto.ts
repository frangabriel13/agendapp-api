import { ApiProperty } from '@nestjs/swagger';

/** El horario de atención de una sucursal, tal como se publica. */
export class PublicBusinessHourDto {
  @ApiProperty({ example: 1, description: '0 = domingo.' }) dayOfWeek!: number;
  @ApiProperty() isClosed!: boolean;

  @ApiProperty({ nullable: true, type: String, example: '09:00' })
  opensAt!: string | null;

  @ApiProperty({ nullable: true, type: String, example: '18:00' })
  closesAt!: string | null;
}

/**
 * Una sucursal, con lo justo para elegirla y llegar.
 *
 * Sin `isActive`: una sucursal inactiva directamente no está en la lista, así
 * que publicar el campo solo invitaría a filtrar de nuevo del lado del portal.
 */
export class PublicBranchDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Sucursal Centro' }) name!: string;
  @ApiProperty({ nullable: true, type: String }) address!: string | null;
  @ApiProperty({ nullable: true, type: String }) phone!: string | null;

  @ApiProperty({
    type: [PublicBusinessHourDto],
    description:
      'El horario de atención semanal. Puede venir vacío si el negocio ' +
      'todavía no lo cargó — ahí esa sucursal no va a ofrecer ningún hueco.',
  })
  businessHours!: PublicBusinessHourDto[];
}

/** Un servicio reservable desde el portal. */
export class PublicServiceDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Corte de dama' }) name!: string;
  @ApiProperty({ nullable: true, type: String }) description!: string | null;

  @ApiProperty({
    example: 45,
    description:
      'Lo que dura la atención. **No incluye el colchón posterior**: lo que el ' +
      'turno ocupa en la agenda puede ser más, y eso lo resuelve la ' +
      'disponibilidad. Es el número para mostrarle a la clienta.',
  })
  durationMinutes!: number;

  @ApiProperty({ example: 100_000, description: 'En centavos.' })
  priceCents!: number;

  @ApiProperty({
    nullable: true,
    type: Number,
    description:
      'La seña que hay que pagar para confirmar. `null` = el servicio no pide ' +
      'seña y el turno queda confirmado al reservar.',
  })
  depositAmountCents!: number | null;

  @ApiProperty({ nullable: true, type: String, example: '#7C3AED' })
  color!: string | null;
}

/**
 * Los servicios agrupados por categoría.
 *
 * Los que no tienen categoría caen en un grupo con `id: null` **al final**, en
 * vez de quedar afuera: un servicio sin categorizar es un descuido de carga, y
 * esconderlo del portal convertiría ese descuido en plata que no entra.
 */
export class PublicServiceGroupDto {
  @ApiProperty({ nullable: true, type: String }) id!: string | null;

  @ApiProperty({
    example: 'Color',
    description: '`"Otros"` para los sin categoría.',
  })
  name!: string;

  @ApiProperty({ type: [PublicServiceDto] }) services!: PublicServiceDto[];
}
