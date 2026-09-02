import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { EmployeeRole } from '@prisma/client';
import { Roles } from '../decorators/roles.decorator';
import { AuditLogsService } from './audit-logs.service';
import {
  ListAuditLogsQueryDto,
  PaginatedAuditLogsDto,
} from './dto/audit-log.dto';

/**
 * El rastro, para el dueño.
 *
 * **Solo `OWNER`.** No es una restricción de configuración como las demás: la
 * auditoría dice quién hizo qué, así que dársela a alguien más sería
 * convertirla en una herramienta para vigilar compañeros. Y quien está siendo
 * auditado no puede ser quien decide qué se ve.
 *
 * Es solo lectura, y no por olvido: la tabla es *append-only*. Un rastro que se
 * puede editar o borrar desde la API no sirve para nada de lo que existe.
 */
@ApiTags('audit-logs')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, vencido o inválido' })
@Roles(EmployeeRole.OWNER)
@Controller('audit-logs')
export class AuditLogsController {
  constructor(private readonly auditLogs: AuditLogsService) {}

  @Get()
  @ApiOperation({
    summary: 'Quién hizo qué en el negocio',
    description:
      'Paginado, de lo más nuevo. Filtros: `entityType` + `entityId` para el ' +
      'historial de una cosa puntual, `userId` para el de una persona, ' +
      '`action` para un tipo de evento, y `from`/`to` (días del calendario ' +
      'del negocio, las dos puntas juntas).\n\n' +
      '`changes` trae **con qué datos se pidió**, ya censurado: contraseñas, ' +
      'tokens y firmas no llegan a guardarse. No es un diff contra el estado ' +
      'anterior — eso un interceptor no lo puede saber.\n\n' +
      'Solo se registra lo que está marcado con `@Audited(...)`: entrar, ' +
      'mover gente del equipo, cancelar turnos y cargar plata a mano. Las ' +
      'lecturas no se auditan.',
  })
  @ApiOkResponse({ type: PaginatedAuditLogsDto })
  @ApiForbiddenResponse({ description: 'Solo el dueño ve la auditoría' })
  @ApiBadRequestResponse({
    description: 'Rango incompleto, invertido o muy largo',
  })
  findAll(
    @Query() query: ListAuditLogsQueryDto,
  ): Promise<PaginatedAuditLogsDto> {
    return this.auditLogs.findAll(query);
  }
}
