import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID, Matches } from 'class-validator';
import { DATE_ONLY_PATTERN } from '../../../common/utils/date-only.util';

const DATE_MESSAGE =
  'La fecha tiene que ser YYYY-MM-DD (por ejemplo 2026-09-01)';

export class AvailabilityQueryDto {
  @ApiProperty({ description: 'Dónde se va a atender.' })
  @IsUUID()
  branchId!: string;

  @ApiProperty({
    description: 'Qué servicio. De acá salen la duración y el buffer.',
  })
  @IsUUID()
  serviceId!: string;

  @ApiProperty({
    example: '2026-09-01',
    pattern: DATE_ONLY_PATTERN,
    description: 'Día del calendario **en la zona horaria del negocio**.',
  })
  @Matches(new RegExp(DATE_ONLY_PATTERN), { message: DATE_MESSAGE })
  date!: string;

  @ApiPropertyOptional({
    description:
      'Si se omite, se consultan todos los que prestan ese servicio en esa ' +
      'sucursal y cada slot dice quiénes pueden tomarlo.',
  })
  @IsOptional()
  @IsUUID()
  employeeId?: string;
}

export class AvailableEmployeeDto {
  @ApiProperty() employeeId!: string;
  @ApiProperty({ example: 'Lucía Fernández' }) employeeName!: string;
}

export class AvailabilitySlotDto {
  @ApiProperty({
    example: '2026-09-01T12:00:00.000Z',
    description: 'Instante en UTC. Mostrarlo en la zona del negocio.',
  })
  startsAt!: Date;

  @ApiProperty({
    example: '2026-09-01T13:00:00.000Z',
    description:
      'Incluye el buffer del servicio: es lo que el turno va a ocupar de ' +
      'verdad, no solo lo que dura la atención.',
  })
  endsAt!: Date;

  @ApiProperty({
    type: [AvailableEmployeeDto],
    description: 'Quiénes tienen ese hueco libre. Nunca viene vacío.',
  })
  employees!: AvailableEmployeeDto[];
}

export class AvailabilityResponseDto {
  @ApiProperty({ example: '2026-09-01' }) date!: string;

  @ApiProperty({
    example: 'America/Argentina/Buenos_Aires',
    description: 'La zona del negocio, con la que hay que mostrar los slots.',
  })
  timezone!: string;

  @ApiProperty({ example: 45 }) durationMinutes!: number;

  @ApiProperty({
    example: 15,
    description: 'Lo que el profesional sigue ocupado después de atender.',
  })
  bufferAfterMinutes!: number;

  @ApiProperty({
    description:
      'La sucursal no abre ese día (día de descanso o feriado cargado). ' +
      'Sirve para distinguir "cerrado" de "sin lugar".',
  })
  branchClosed!: boolean;

  @ApiProperty({ type: [AvailabilitySlotDto] })
  slots!: AvailabilitySlotDto[];
}
