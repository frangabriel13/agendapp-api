import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { TIME_OF_DAY_PATTERN } from '../../../common/utils/time-of-day.util';

/** Domingo = 0 … sábado = 6, igual que `Date.getDay()`. */
export const DAYS_IN_WEEK = 7;

const TIME_MESSAGE = 'La hora tiene que venir como HH:MM (ej. 09:30)';

/** Un día de la semana dentro del horario de atención de una sucursal. */
export class BusinessHourDto {
  @ApiProperty({
    minimum: 0,
    maximum: 6,
    example: 1,
    description: '0 = domingo, 6 = sábado.',
  })
  @IsInt()
  @Min(0)
  @Max(DAYS_IN_WEEK - 1)
  dayOfWeek!: number;

  @ApiPropertyOptional({
    default: false,
    description: 'Si es `true`, el día va sin horas: la sucursal no atiende.',
  })
  @IsOptional()
  @IsBoolean()
  isClosed?: boolean;

  @ApiPropertyOptional({ example: '09:00', pattern: TIME_OF_DAY_PATTERN })
  @IsOptional()
  @Matches(new RegExp(TIME_OF_DAY_PATTERN), { message: TIME_MESSAGE })
  opensAt?: string;

  @ApiPropertyOptional({ example: '18:00', pattern: TIME_OF_DAY_PATTERN })
  @IsOptional()
  @Matches(new RegExp(TIME_OF_DAY_PATTERN), { message: TIME_MESSAGE })
  closesAt?: string;
}

/**
 * Body de `PUT /branches/:id/business-hours`.
 *
 * Es un PUT y no un PATCH porque reemplaza la semana entera: mandar los 7 días
 * siempre evita el estado ambiguo de "el martes quedó del set anterior".
 */
export class SetBusinessHoursDto {
  @ApiProperty({
    type: [BusinessHourDto],
    description: `Los ${DAYS_IN_WEEK} días de la semana, sin repetir ninguno.`,
  })
  @IsArray()
  @ArrayMinSize(DAYS_IN_WEEK)
  @ArrayMaxSize(DAYS_IN_WEEK)
  @ValidateNested({ each: true })
  @Type(() => BusinessHourDto)
  days!: BusinessHourDto[];
}

/** Un día tal como sale de la API. Las horas van en `null` si está cerrado. */
export class BusinessHourResponseDto {
  @ApiProperty({ example: 1 }) dayOfWeek!: number;
  @ApiProperty() isClosed!: boolean;

  @ApiProperty({ nullable: true, type: String, example: '09:00' })
  opensAt!: string | null;

  @ApiProperty({ nullable: true, type: String, example: '18:00' })
  closesAt!: string | null;
}
