import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AppointmentsService } from './appointments.service';
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
}
