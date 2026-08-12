import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
} from 'class-validator';
import { DATE_ONLY_PATTERN } from '../../../common/utils/date-only.util';
import { TIME_OF_DAY_PATTERN } from '../../../common/utils/time-of-day.util';
import { trim } from '../../../common/utils/trim.transform';

const DATE_MESSAGE =
  'La fecha tiene que venir como YYYY-MM-DD (ej. 2026-12-25)';
const TIME_MESSAGE = 'La hora tiene que venir como HH:MM (ej. 09:30)';

/** Un día especial tal como sale de la API. */
export class SpecialDayResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: '2026-12-25' }) date!: string;

  @ApiProperty({ description: '`true` = feriado; `false` = horario especial.' })
  isClosed!: boolean;

  @ApiProperty({ nullable: true, type: String, example: '10:00' })
  opensAt!: string | null;

  @ApiProperty({ nullable: true, type: String, example: '14:00' })
  closesAt!: string | null;

  @ApiProperty({ nullable: true, type: String, example: 'Navidad' })
  description!: string | null;
}

export class CreateSpecialDayDto {
  @ApiProperty({ example: '2026-12-25', pattern: DATE_ONLY_PATTERN })
  @Matches(new RegExp(DATE_ONLY_PATTERN), { message: DATE_MESSAGE })
  date!: string;

  @ApiPropertyOptional({
    default: true,
    description:
      'Cerrado (feriado) por defecto. En `false` es una jornada con horario ' +
      'especial y exige `opensAt` y `closesAt`.',
  })
  @IsOptional()
  @IsBoolean()
  isClosed?: boolean;

  @ApiPropertyOptional({ example: '10:00', pattern: TIME_OF_DAY_PATTERN })
  @IsOptional()
  @Matches(new RegExp(TIME_OF_DAY_PATTERN), { message: TIME_MESSAGE })
  opensAt?: string;

  @ApiPropertyOptional({ example: '14:00', pattern: TIME_OF_DAY_PATTERN })
  @IsOptional()
  @Matches(new RegExp(TIME_OF_DAY_PATTERN), { message: TIME_MESSAGE })
  closesAt?: string;

  @ApiPropertyOptional({ example: 'Navidad', maxLength: 255 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(255)
  description?: string | null;
}

/**
 * La fecha no se edita: cambiar el día de un feriado es borrarlo y crear otro.
 * Así el `UNIQUE(branch_id, date)` no se vuelve una fuente de 409 raros.
 */
export class UpdateSpecialDayDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isClosed?: boolean;

  @ApiPropertyOptional({ example: '10:00', pattern: TIME_OF_DAY_PATTERN })
  @IsOptional()
  @Matches(new RegExp(TIME_OF_DAY_PATTERN), { message: TIME_MESSAGE })
  opensAt?: string;

  @ApiPropertyOptional({ example: '14:00', pattern: TIME_OF_DAY_PATTERN })
  @IsOptional()
  @Matches(new RegExp(TIME_OF_DAY_PATTERN), { message: TIME_MESSAGE })
  closesAt?: string;

  @ApiPropertyOptional({
    nullable: true,
    example: 'Navidad',
    description: '`null` borra la descripción.',
  })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(255)
  description?: string | null;
}

/** Query string de `GET /branches/:id/special-days`. */
export class ListSpecialDaysQueryDto {
  @ApiPropertyOptional({
    example: '2026-01-01',
    pattern: DATE_ONLY_PATTERN,
    description: 'Desde (inclusive).',
  })
  @IsOptional()
  @Matches(new RegExp(DATE_ONLY_PATTERN), { message: DATE_MESSAGE })
  from?: string;

  @ApiPropertyOptional({
    example: '2026-12-31',
    pattern: DATE_ONLY_PATTERN,
    description: 'Hasta (inclusive).',
  })
  @IsOptional()
  @Matches(new RegExp(DATE_ONLY_PATTERN), { message: DATE_MESSAGE })
  to?: string;
}
