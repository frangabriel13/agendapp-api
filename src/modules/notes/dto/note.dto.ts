import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { NoteEntityType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import {
  PaginationMetaDto,
  PaginationQueryDto,
} from '../../../common/dto/pagination.dto';
import { trim } from '../../../common/utils/trim.transform';

/**
 * Tope del cuerpo de una nota. Más largo que las notas de mostrador de un
 * cliente (5000) sería convertir esto en un editor de documentos; más corto
 * obligaría a partir en dos una indicación de color con todos sus pasos.
 */
export const MAX_NOTE_LENGTH = 5_000;

export class NoteAuthorDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Lucía' }) firstName!: string;
  @ApiProperty({ example: 'Fernández' }) lastName!: string;
}

export class NoteResponseDto {
  @ApiProperty() id!: string;

  @ApiProperty({
    type: NoteAuthorDto,
    description:
      'Quién la escribió. Nunca es `null`: una nota sin autor no se puede ' +
      'discutir ni moderar.',
  })
  author!: NoteAuthorDto;

  @ApiProperty({ example: 'Vino con el pelo teñido en casa, ojo con el color' })
  content!: string;

  @ApiProperty({
    description:
      'La ven **solo su autor y el dueño del negocio**. No es una etiqueta: ' +
      'el listado directamente no devuelve las ajenas.',
  })
  isPrivate!: boolean;

  @ApiProperty({ enum: NoteEntityType }) entityType!: NoteEntityType;

  @ApiProperty({
    nullable: true,
    type: String,
    description: '`null` solo cuando `entityType` es `GENERAL`.',
  })
  entityId!: string | null;

  @ApiProperty() createdAt!: Date;
  @ApiProperty() updatedAt!: Date;
}

export class PaginatedNotesDto {
  @ApiProperty({ type: [NoteResponseDto] }) data!: NoteResponseDto[];
  @ApiProperty({ type: PaginationMetaDto }) meta!: PaginationMetaDto;
}

export class CreateNoteDto {
  @ApiProperty({
    enum: NoteEntityType,
    description:
      'Sobre qué es. `GENERAL` es la nota del negocio y va **sin** `entityId`; ' +
      'los demás lo exigen.',
  })
  @IsEnum(NoteEntityType)
  entityType!: NoteEntityType;

  @ApiPropertyOptional({
    description:
      'Obligatorio salvo con `GENERAL`, donde tiene que estar ausente. Se ' +
      'valida que la entidad exista y sea de este negocio.',
  })
  // Acá solo se valida el **formato**. Que tenga que estar (o no estar) según
  // el tipo lo decide `NotesService`: es una regla entre dos campos, y dos
  // `@ValidateIf` sobre la misma propiedad se pisan entre sí — el resultado
  // era que ninguna de las dos mitades se aplicaba y el error terminaba
  // saliendo del CHECK de la base como un 500.
  @IsOptional()
  @IsUUID()
  entityId?: string;

  @ApiProperty({ maxLength: MAX_NOTE_LENGTH })
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'La nota no puede estar vacía' })
  @MaxLength(MAX_NOTE_LENGTH)
  content!: string;

  @ApiPropertyOptional({
    default: false,
    description: 'En `true`, solo la ven vos y el dueño del negocio.',
  })
  @IsOptional()
  @IsBoolean()
  isPrivate?: boolean;
}

/** Lo editable. El destino no: una nota que cambia de dueño es otra nota. */
export class UpdateNoteDto {
  @ApiPropertyOptional({ maxLength: MAX_NOTE_LENGTH })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1, { message: 'La nota no puede estar vacía' })
  @MaxLength(MAX_NOTE_LENGTH)
  content?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isPrivate?: boolean;
}

export class ListNotesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    enum: NoteEntityType,
    description: 'Sin esto vienen todas las del negocio, de lo más nuevo.',
  })
  @IsOptional()
  @IsEnum(NoteEntityType)
  entityType?: NoteEntityType;

  @ApiPropertyOptional({
    description:
      'Filtra por entidad. **Exige `entityType`**: el índice es ' +
      '`(tenant, tipo, id)` y sin el tipo la consulta no puede usarlo. ' +
      'Tampoco es una molestia: quien pide las notas de algo siempre sabe ' +
      'qué es ese algo.',
  })
  @IsOptional()
  @IsUUID()
  entityId?: string;
}
