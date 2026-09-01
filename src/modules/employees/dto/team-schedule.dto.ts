import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsISO8601, IsOptional, IsUUID } from 'class-validator';
import { booleanQueryParam } from '../../../common/utils/boolean-query.transform';
import { EmployeeShiftResponseDto } from './employee-schedule.dto';
import { TimeOffResponseDto } from './employee-time-off.dto';

const ISO_MESSAGE =
  'La fecha y hora tienen que venir en ISO 8601 con zona (ej. 2026-01-05T09:00:00-03:00)';

/**
 * Tope del rango pedido.
 *
 * El horario semanal no depende del rango, pero las ausencias sí, y sin tope
 * esto crece para siempre: una grilla siempre sabe qué semana o qué mes está
 * mirando, así que pedir un año entero es un error de quien llama, no un caso
 * de uso. Un trimestre entra cómodo.
 */
export const MAX_TEAM_RANGE_DAYS = 92;

export class TeamScheduleQueryDto {
  @ApiProperty({
    example: '2026-01-01T00:00:00Z',
    description:
      'Desde cuándo mirar las **ausencias**. Obligatorio: sin rango la ' +
      'respuesta crecería sin techo.',
  })
  @IsISO8601({ strict: true }, { message: ISO_MESSAGE })
  from!: string;

  @ApiProperty({
    example: '2026-01-31T23:59:59Z',
    description: `Hasta cuándo. El rango no puede pasar de ${MAX_TEAM_RANGE_DAYS} días.`,
  })
  @IsISO8601({ strict: true }, { message: ISO_MESSAGE })
  to!: string;

  @ApiPropertyOptional({
    description:
      'Solo los que trabajan en esta sucursal, y solo sus tramos de ahí. Las ' +
      'ausencias sin sucursal entran igual: no estar en ninguna incluye a esta.',
  })
  @IsOptional()
  @IsUUID('4')
  branchId?: string;

  @ApiPropertyOptional({
    description: 'Filtra por estado. Sin esto, vienen todos.',
  })
  @IsOptional()
  @Transform(booleanQueryParam('isActive'))
  @IsBoolean()
  isActive?: boolean;
}

/**
 * El horario declarado de una persona más lo que lo interrumpe.
 *
 * Los dos viajan juntos porque separados mienten: una grilla que pinta el
 * horario sin las ausencias muestra a alguien atendiendo el martes que se fue
 * de vacaciones. Esto **no** es la disponibilidad real —eso es
 * `GET /appointments/availability`, que además descuenta turnos tomados,
 * recursos ocupados y el horario de la sucursal—.
 */
export class TeamMemberScheduleDto {
  @ApiProperty() employeeId!: string;

  @ApiProperty({
    example: 'Ana Gómez',
    description: 'Nombre y apellido, para que la grilla no tenga que cruzar.',
  })
  employeeName!: string;

  @ApiProperty() isActive!: boolean;

  @ApiProperty({
    type: [EmployeeShiftResponseDto],
    description:
      'El horario semanal, igual que en `GET /employees/:id/schedules`. No ' +
      'depende del rango pedido: es una plantilla por día de la semana.',
  })
  shifts!: EmployeeShiftResponseDto[];

  @ApiProperty({
    type: [TimeOffResponseDto],
    description:
      'Las ausencias que **tocan** el rango, no solo las que caen enteras ' +
      'adentro: unas vacaciones de enero a marzo aparecen al mirar febrero.',
  })
  timeOff!: TimeOffResponseDto[];
}
