import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { TIME_OF_DAY_PATTERN } from '../../../common/utils/time-of-day.util';

const TIME_MESSAGE = 'La hora tiene que venir como HH:MM (ej. 09:30)';

/**
 * Tope defensivo de tramos por set. Una semana con turno partido en las 7
 * sucursales de un plan grande no llega ni cerca; esto solo evita que alguien
 * mande 10.000 filas de una.
 */
const MAX_SHIFTS = 200;

/**
 * Un tramo de trabajo: día, sucursal y horario.
 *
 * A diferencia del horario de la sucursal, acá NO hay una fila por día ni
 * bandera de "cerrado": un día sin tramos es un día que el empleado no trabaja,
 * y dos tramos el mismo día son un turno partido (mañana y tarde).
 */
export class EmployeeShiftDto {
  @ApiProperty({ description: 'Sucursal donde cubre este tramo.' })
  @IsUUID('4')
  branchId!: string;

  @ApiProperty({ minimum: 0, maximum: 6, example: 1 })
  @IsInt()
  @Min(0)
  @Max(6)
  dayOfWeek!: number;

  @ApiProperty({ example: '09:00', pattern: TIME_OF_DAY_PATTERN })
  @Matches(new RegExp(TIME_OF_DAY_PATTERN), { message: TIME_MESSAGE })
  startsAt!: string;

  @ApiProperty({ example: '13:00', pattern: TIME_OF_DAY_PATTERN })
  @Matches(new RegExp(TIME_OF_DAY_PATTERN), { message: TIME_MESSAGE })
  endsAt!: string;
}

/**
 * Body de `PUT /employees/:id/schedules`: reemplaza el horario completo del
 * empleado en TODAS sus sucursales. Mandar un array vacío lo deja sin horario.
 */
export class SetEmployeeSchedulesDto {
  @ApiProperty({ type: [EmployeeShiftDto] })
  @IsArray()
  @ArrayMaxSize(MAX_SHIFTS)
  @ValidateNested({ each: true })
  @Type(() => EmployeeShiftDto)
  shifts!: EmployeeShiftDto[];
}

export class EmployeeShiftResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() branchId!: string;
  @ApiProperty({ example: 1 }) dayOfWeek!: number;
  @ApiProperty({ example: '09:00' }) startsAt!: string;
  @ApiProperty({ example: '13:00' }) endsAt!: string;
}
