import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types/jwt-payload';
import {
  CreateNoteDto,
  ListNotesQueryDto,
  NoteResponseDto,
  PaginatedNotesDto,
  UpdateNoteDto,
} from './dto/note.dto';
import { NotesService } from './notes.service';

/**
 * La bitácora interna: quién anotó qué, sobre qué y cuándo.
 *
 * **Sin `@Roles`, a propósito.** Anotar es trabajo de cualquiera que atienda, y
 * las dos reglas que sí importan —quién ve una nota privada y quién puede
 * editarla— dependen de la fila y no del endpoint, así que las aplica el
 * service. Un `@Roles` acá daría una falsa sensación de que el permiso está
 * resuelto en la puerta.
 *
 * ⚠️ **No confundir con `Customer.notes`.** Ese es el campo de la ficha: uno
 * solo, sin autor ni fecha, y el panel ya lo usa. Esto es el historial.
 */
@ApiTags('notes')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, vencido o inválido' })
@ApiNotFoundResponse({ description: 'La nota no existe (o no es tuya)' })
@Controller('notes')
export class NotesController {
  constructor(private readonly notesService: NotesService) {}

  @Post()
  @ApiOperation({
    summary: 'Escribe una nota',
    description:
      '`entityType` dice sobre qué es. `GENERAL` es la nota del negocio y va ' +
      '**sin** `entityId`; los demás tipos lo exigen y se valida que la ' +
      'entidad exista y sea de tu negocio — la nota es polimórfica, así que ' +
      'no hay foreign key que lo garantice.\n\n' +
      'Con `isPrivate: true` la nota la ven **solo vos y el dueño**.',
  })
  @ApiCreatedResponse({ type: NoteResponseDto })
  @ApiBadRequestResponse({
    description: 'La entidad no existe, o el `entityId` no corresponde al tipo',
  })
  create(
    @Body() dto: CreateNoteDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<NoteResponseDto> {
    return this.notesService.create(dto, user);
  }

  @Get()
  @ApiOperation({
    summary: 'Lista notas, de la más nueva',
    description:
      'Paginado. Para las de una entidad van los dos filtros juntos ' +
      '(`entityType` **y** `entityId`); sin filtros vienen todas las del ' +
      'negocio.\n\n' +
      'Las notas privadas ajenas **no aparecen**: no vienen marcadas ni ' +
      'recortadas, directamente no están.',
  })
  @ApiOkResponse({ type: PaginatedNotesDto })
  @ApiBadRequestResponse({ description: '`entityId` sin `entityType`' })
  findAll(
    @Query() query: ListNotesQueryDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PaginatedNotesDto> {
    return this.notesService.findAll(query, user);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Devuelve una nota',
    description:
      'Una nota privada ajena responde **404 y no 403**: un 403 confirmaría ' +
      'que existe, que es justo lo que "privada" tiene que esconder.',
  })
  @ApiOkResponse({ type: NoteResponseDto })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<NoteResponseDto> {
    return this.notesService.findOne(id, user);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edita el texto o la privacidad de una nota',
    description:
      'El destino no se edita: una nota que cambia de entidad es otra nota. ' +
      'Solo puede quien la escribió, o el dueño del negocio.',
  })
  @ApiOkResponse({ type: NoteResponseDto })
  @ApiForbiddenResponse({ description: 'La nota es de otra persona' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateNoteDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<NoteResponseDto> {
    return this.notesService.update(id, dto, user);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Da de baja una nota',
    description: 'Solo quien la escribió, o el dueño del negocio.',
  })
  @ApiNoContentResponse({ description: 'Nota dada de baja' })
  @ApiForbiddenResponse({ description: 'La nota es de otra persona' })
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<void> {
    return this.notesService.remove(id, user);
  }
}
