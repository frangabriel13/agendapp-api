import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsUUID,
  Matches,
} from 'class-validator';
import { DATE_ONLY_PATTERN } from '../../../common/utils/date-only.util';
import { MAX_SERVICES_PER_APPOINTMENT } from './appointment.dto';

const DATE_MESSAGE =
  'La fecha tiene que ser YYYY-MM-DD (por ejemplo 2026-09-01)';

export class AvailabilityQueryDto {
  @ApiProperty({ description: 'Dónde se va a atender.' })
  @IsUUID()
  branchId!: string;

  @ApiProperty({
    type: [String],
    minItems: 1,
    maxItems: MAX_SERVICES_PER_APPOINTMENT,
    description:
      'Qué servicios, repitiendo el parámetro: ' +
      '`?serviceIds=<a>&serviceIds=<b>`. **Los mismos que se van a mandar al ' +
      'agendar**: la duración del hueco es la suma de todos, buffers ' +
      'incluidos, así que consultar con uno solo de un turno de varios ' +
      'ofrece horarios en los que el turno después no entra.',
  })
  // Un solo valor llega como string y no como array: sin esto, pedir un
  // servicio suelto —el caso más común— fallaría la validación.
  @Transform(({ value }: { value: unknown }) =>
    value === undefined || Array.isArray(value) ? value : [value],
  )
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_SERVICES_PER_APPOINTMENT)
  @IsUUID(undefined, { each: true })
  serviceIds!: string[];

  @ApiProperty({
    example: '2026-09-01',
    pattern: DATE_ONLY_PATTERN,
    description: 'Día del calendario **en la zona horaria del negocio**.',
  })
  @Matches(new RegExp(DATE_ONLY_PATTERN), { message: DATE_MESSAGE })
  date!: string;

  @ApiPropertyOptional({
    description:
      'Si se omite, se consultan todos los que prestan **todos** esos ' +
      'servicios en esa sucursal y cada slot dice quiénes pueden tomarlo.',
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
      'Incluye los buffers: es lo que el turno va a ocupar de verdad, no solo ' +
      'lo que dura la atención.',
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

  @ApiProperty({
    example: 45,
    description: 'La suma de lo que dura cada servicio pedido.',
  })
  durationMinutes!: number;

  @ApiProperty({
    example: 15,
    description:
      'La suma de los buffers de los servicios pedidos. Con uno solo es lo ' +
      'que el profesional sigue ocupado después de atender; **con varios hay ' +
      'buffers en el medio**, así que no es "lo que queda al final" sino todo ' +
      'el tiempo de limpieza del turno. Lo que se sostiene en los dos casos ' +
      'es que `durationMinutes + bufferAfterMinutes` es lo que dura el hueco.',
  })
  bufferAfterMinutes!: number;

  @ApiProperty({
    description:
      'La sucursal no abre ese día (día de descanso o feriado cargado). ' +
      'Sirve para distinguir "cerrado" de "sin lugar".',
  })
  branchClosed!: boolean;

  @ApiProperty({
    description:
      'Nadie presta **todos** los servicios pedidos en esa sucursal — o, si ' +
      'se pasó `employeeId`, esa persona no los presta todos. Es el tercer ' +
      'motivo por el que `slots` puede venir vacío, y el único que no se ' +
      'arregla cambiando de día.',
  })
  noEmployeeForServices!: boolean;

  @ApiProperty({ type: [AvailabilitySlotDto] })
  slots!: AvailabilitySlotDto[];
}
