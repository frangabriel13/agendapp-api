import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../auth/types/jwt-payload';
import { AppointmentsService } from './appointments.service';
import {
  AppointmentResponseDto,
  ChangeAppointmentStatusDto,
  ChangeStatusResultDto,
  CreateAppointmentDto,
  ListAppointmentsQueryDto,
  RescheduleAppointmentDto,
  UpdateAppointmentDto,
} from './dto/appointment.dto';
import {
  AvailabilityQueryDto,
  AvailabilityResponseDto,
} from './dto/availability.dto';

@ApiTags('appointments')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, vencido o inválido' })
@Controller('appointments')
export class AppointmentsController {
  constructor(private readonly appointmentsService: AppointmentsService) {}

  /**
   * ⚠️ Va **antes** de `@Get(':id')`. Nest resuelve las rutas en el orden en que
   * están declaradas, así que si `:id` estuviera primero se comería
   * `/appointments/availability` y respondería 400 por un uuid inválido.
   */
  @Get('availability')
  @ApiOperation({
    summary: 'Huecos libres para reservar un servicio un día dado',
    description:
      'Cruza el horario de la sucursal con el del profesional y le resta ' +
      'ausencias, turnos ya tomados y recursos ocupados. Los slots duran ' +
      '`durationMinutes + bufferAfterMinutes`: el buffer es tiempo en el que ' +
      'el profesional sigue ocupado, así que el último turno del día termina ' +
      'antes del cierre.\n\n' +
      'Sin `employeeId` responde por todos los que prestan el servicio en esa ' +
      'sucursal, y cada slot dice quiénes lo tienen libre.\n\n' +
      '**No recorta los slots que ya pasaron**: describe lo que el horario ' +
      'permite, no lo que todavía se puede reservar. Una pantalla de reserva ' +
      'para el público tiene que filtrarlos.',
  })
  @ApiOkResponse({ type: AvailabilityResponseDto })
  @ApiBadRequestResponse({
    description: 'Datos inválidos, o el servicio está desactivado',
  })
  @ApiNotFoundResponse({ description: 'La sucursal o el servicio no existen' })
  findAvailability(
    @Query() query: AvailabilityQueryDto,
  ): Promise<AvailabilityResponseDto> {
    return this.appointmentsService.findAvailability(query);
  }

  @Post()
  @ApiOperation({
    summary: 'Agenda un turno',
    description:
      'El horario de fin lo calcula el servidor sumando duración y buffer de ' +
      'cada servicio. El precio y la duración se **congelan** en el turno: si ' +
      'mañana cambia la lista de precios, este turno sigue valiendo lo que ' +
      'valía.\n\n' +
      'No hace falta que el horario coincida con un slot de ' +
      '`/availability`: alcanza con que entre en el tiempo libre del ' +
      'profesional. Eso permite agendar a las 09:07 a alguien que llegó sin ' +
      'turno.',
  })
  @ApiCreatedResponse({ type: AppointmentResponseDto })
  @ApiBadRequestResponse({
    description:
      'Datos inválidos, el profesional no presta ese servicio ahí, o el ' +
      'cliente o los servicios no existen',
  })
  @ApiConflictResponse({
    description:
      'Ese horario no está libre. También es la respuesta cuando dos personas ' +
      'reservan el mismo hueco a la vez: una lo consigue y la otra recibe esto.',
  })
  create(
    @Body() dto: CreateAppointmentDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AppointmentResponseDto> {
    return this.appointmentsService.create(dto, user.userId);
  }

  @Get()
  @ApiOperation({
    summary: 'La agenda de un rango de fechas',
    description:
      'Pensado para un calendario: se pide un rango (`from`/`to`, inclusive, ' +
      'en días del calendario del negocio) y vienen todos los turnos que lo ' +
      'tocan, ordenados por hora. Un turno que arranca el día anterior y ' +
      'termina dentro del rango también viene.',
  })
  @ApiOkResponse({ type: [AppointmentResponseDto] })
  @ApiBadRequestResponse({ description: 'Rango inválido o demasiado largo' })
  findAll(
    @Query() query: ListAppointmentsQueryDto,
  ): Promise<AppointmentResponseDto[]> {
    return this.appointmentsService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Devuelve un turno' })
  @ApiOkResponse({ type: AppointmentResponseDto })
  @ApiNotFoundResponse({ description: 'El turno no existe' })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AppointmentResponseDto> {
    return this.appointmentsService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edita las notas de un turno',
    description:
      'Es lo único editable. Mover el horario es reprogramar, y cambiar el ' +
      'estado tiene su propio endpoint.',
  })
  @ApiOkResponse({ type: AppointmentResponseDto })
  @ApiNotFoundResponse({ description: 'El turno no existe' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAppointmentDto,
  ): Promise<AppointmentResponseDto> {
    return this.appointmentsService.update(id, dto);
  }

  @Patch(':id/status')
  @ApiOperation({
    summary: 'Confirma, cancela o cierra un turno',
    description:
      'Las transiciones válidas son:\n\n' +
      '- `pending_payment` → `confirmed`, o cancelado\n' +
      '- `confirmed` → `attended`, `no_show`, o cancelado\n' +
      '- el resto son finales\n\n' +
      'Al cancelar, la respuesta trae en `refund` qué corresponde devolver ' +
      'según la política del negocio. **No mueve plata**: eso es la Fase 6.',
  })
  @ApiOkResponse({ type: ChangeStatusResultDto })
  @ApiConflictResponse({ description: 'Esa transición de estado no es válida' })
  @ApiNotFoundResponse({ description: 'El turno no existe' })
  changeStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeAppointmentStatusDto,
  ): Promise<ChangeStatusResultDto> {
    return this.appointmentsService.changeStatus(id, dto);
  }

  @Post(':id/reschedule')
  @ApiOperation({
    summary: 'Mueve un turno a otro horario',
    description:
      'Crea un turno nuevo y deja el viejo en `rescheduled`, enlazados por ' +
      '`rescheduledFromId` / `rescheduledToId`. No se edita el original a ' +
      'propósito: así el historial dice que hubo un cambio.\n\n' +
      'Los servicios se copian **con el precio que tenían**: la clienta ya lo ' +
      'había acordado.',
  })
  @ApiCreatedResponse({
    type: AppointmentResponseDto,
    description: 'El turno nuevo.',
  })
  @ApiConflictResponse({
    description: 'El turno ya está cerrado, o el horario nuevo no está libre',
  })
  @ApiNotFoundResponse({ description: 'El turno no existe' })
  reschedule(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RescheduleAppointmentDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AppointmentResponseDto> {
    return this.appointmentsService.reschedule(id, dto, user.userId);
  }
}
