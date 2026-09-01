import { ApiProperty } from '@nestjs/swagger';

/*
 * ⚠️ `PublicBookingPolicyDto` va declarado ANTES que `PublicBusinessDto`, que lo
 * usa. No es prolijidad: `emitDecoratorMetadata` emite el `design:type` como
 * una referencia directa a la clase en el momento de definirla, así que al
 * revés revienta en tiempo de carga con "Cannot access ... before
 * initialization" — y el `type: () => ...` de Swagger, que sí es lazy, no lo
 * salva.
 */

/**
 * Las reglas de reserva, publicadas para que el portal no tenga que adivinarlas.
 *
 * Sin esto, la única forma de saber que un horario no se acepta es mandarlo y
 * comerse un 400 — y el visitante ve un error donde debería ver un día
 * deshabilitado.
 */
export class PublicBookingPolicyDto {
  @ApiProperty({
    description:
      'Si el negocio está tomando reservas online. En `false` el portal se ve ' +
      'igual —servicios, precios, teléfono— y el botón de reservar no va: ' +
      '`POST /public/:slug/appointments` contesta 403.',
  })
  enabled!: boolean;

  @ApiProperty({
    example: 120,
    description:
      'Antelación mínima, en minutos. Un hueco más cerca que esto no se ofrece.',
  })
  minNoticeMinutes!: number;

  @ApiProperty({
    example: 60,
    description: 'Hasta cuántos días adelante se puede reservar.',
  })
  maxDaysAhead!: number;

  @ApiProperty({
    description:
      'Si el turno exige pagar la seña para quedar confirmado. **En el portal ' +
      'es siempre `true`**: se cobra siempre que el servicio tenga una, sin ' +
      'importar cómo esté configurado el mostrador. Un desconocido que reserva ' +
      'sin poner plata no tiene ningún costo por no aparecer.',
  })
  depositRequired!: boolean;

  @ApiProperty({
    example: 24,
    description: 'Horas de anticipación para cancelar sin penalidad.',
  })
  cancellationPolicyHours!: number;
}

/**
 * Lo que el portal muestra del negocio.
 *
 * Todo lo que está acá es deliberadamente **lo que el negocio ya publica en su
 * vidriera**: cómo se llama, cómo se ve, en qué zona horaria atiende. Nada de
 * plan, estado de suscripción, cantidad de empleados ni fechas internas — eso
 * es del panel, y acá no lo pide nadie.
 */
export class PublicBusinessDto {
  @ApiProperty({ example: 'peluqueria-ana' }) slug!: string;

  @ApiProperty({
    example: 'Peluquería Ana',
    description:
      'El nombre para mostrar del branding. Si el negocio no cargó uno, cae ' +
      'al nombre con el que se registró.',
  })
  displayName!: string;

  @ApiProperty({ nullable: true, type: String }) description!: string | null;
  @ApiProperty({ nullable: true, type: String }) logoUrl!: string | null;

  @ApiProperty({ nullable: true, type: String, example: '#7C3AED' })
  primaryColor!: string | null;

  @ApiProperty({
    example: 'America/Argentina/Buenos_Aires',
    description:
      'La zona del negocio. **Hace falta sí o sí**: los horarios viajan en ' +
      'UTC y sin esto el portal los pinta en la zona del visitante, que puede ' +
      'ser otra.',
  })
  timezone!: string;

  @ApiProperty({ example: 'ARS' }) currency!: string;
  @ApiProperty({ example: 'es' }) language!: string;

  @ApiProperty({
    type: PublicBookingPolicyDto,
    description: 'Las reglas que el portal tiene que respetar al reservar.',
  })
  booking!: PublicBookingPolicyDto;
}
