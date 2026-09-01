import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TimeOffKind } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { trim } from '../../../common/utils/trim.transform';

const ISO_MESSAGE =
  'La fecha y hora tienen que venir en ISO 8601 con zona (ej. 2026-01-05T09:00:00-03:00)';

/**
 * Una ausencia SÍ es un intervalo de tiempo real, no hora de pared: arranca un
 * día a una hora y termina otro. Por eso viaja en ISO 8601 completo y se guarda
 * en `TIMESTAMPTZ`, a diferencia de los horarios semanales.
 */
export class CreateTimeOffDto {
  @ApiPropertyOptional({
    nullable: true,
    description:
      'Sucursal donde no va a estar. `null` (o ausente) = en ninguna, que es ' +
      'el caso normal de unas vacaciones.',
  })
  @IsOptional()
  @IsUUID('4')
  branchId?: string | null;

  @ApiPropertyOptional({
    enum: TimeOffKind,
    default: TimeOffKind.OTHER,
    description:
      'Qué clase de ausencia es. Es opcional para no romper a quien ya venía ' +
      'cargando ausencias sin el campo, pero mandarlo es lo que evita que el ' +
      'panel tenga que adivinar la categoría leyendo el `reason`.',
  })
  @IsOptional()
  @IsEnum(TimeOffKind)
  kind?: TimeOffKind;

  @ApiProperty({ example: '2026-01-05T09:00:00-03:00' })
  @IsISO8601({ strict: true }, { message: ISO_MESSAGE })
  startsAt!: string;

  @ApiProperty({ example: '2026-01-20T09:00:00-03:00' })
  @IsISO8601({ strict: true }, { message: ISO_MESSAGE })
  endsAt!: string;

  @ApiPropertyOptional({ example: 'Vacaciones', maxLength: 255 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(255)
  reason?: string | null;
}

export class ListTimeOffQueryDto {
  @ApiPropertyOptional({
    example: '2026-01-01T00:00:00Z',
    description: 'Devuelve las ausencias que se solapan con [from, to].',
  })
  @IsOptional()
  @IsISO8601({ strict: true }, { message: ISO_MESSAGE })
  from?: string;

  @ApiPropertyOptional({ example: '2026-12-31T23:59:59Z' })
  @IsOptional()
  @IsISO8601({ strict: true }, { message: ISO_MESSAGE })
  to?: string;
}

export class TimeOffResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() employeeId!: string;

  @ApiProperty({
    nullable: true,
    type: String,
    description: '`null` = en todas las sucursales.',
  })
  branchId!: string | null;

  @ApiProperty({
    enum: TimeOffKind,
    description:
      'Las ausencias cargadas antes de que existiera el campo son `OTHER`: ' +
      'no es que sean "otra cosa", es que no se sabe.',
  })
  kind!: TimeOffKind;

  @ApiProperty() startsAt!: Date;
  @ApiProperty() endsAt!: Date;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'La nota humana. `kind` es la parte que la máquina lee.',
  })
  reason!: string | null;
}
