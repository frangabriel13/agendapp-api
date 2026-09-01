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
  Put,
  Query,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { EmployeeRole } from '@prisma/client';
import { Public } from '../../common/decorators/public.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { EmployeeInvitationService } from './employee-invitations.service';
import { EmployeesService } from './employees.service';
import {
  EmployeeShiftResponseDto,
  SetEmployeeSchedulesDto,
} from './dto/employee-schedule.dto';
import {
  CreateTimeOffDto,
  ListTimeOffQueryDto,
  TimeOffResponseDto,
} from './dto/employee-time-off.dto';
import {
  TeamMemberScheduleDto,
  TeamScheduleQueryDto,
} from './dto/team-schedule.dto';
import {
  ActivateEmployeeDto,
  EmployeeDetailResponseDto,
  EmployeeInvitationResponseDto,
  EmployeeResponseDto,
  InviteEmployeeDto,
  ListEmployeesQueryDto,
  SetEmployeeBranchesDto,
  UpdateEmployeeDto,
} from './dto/employee.dto';

/** Manejar el equipo es cosa del dueño o de administración. */
const MANAGERS = [EmployeeRole.OWNER, EmployeeRole.ADMINISTRATIVE] as const;

@ApiTags('employees')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, vencido o inválido' })
@Controller('employees')
export class EmployeesController {
  constructor(
    private readonly employeesService: EmployeesService,
    private readonly invitations: EmployeeInvitationService,
  ) {}

  /**
   * Va declarado ANTES que las rutas con `:id` para que `activate` no se coma
   * un parámetro. Es la única ruta pública del módulo: la abre el token de la
   * invitación, no el JWT.
   */
  @Post('activate')
  @Public()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Activa la cuenta de un empleado invitado',
    description:
      'Recibe el token del link de invitación y la contraseña elegida. ' +
      'Después de esto el empleado ya puede iniciar sesión normalmente.',
  })
  @ApiNoContentResponse({ description: 'Cuenta activada' })
  @ApiBadRequestResponse({
    description: 'El link no es válido, ya se usó o venció',
  })
  activate(@Body() dto: ActivateEmployeeDto): Promise<void> {
    return this.invitations.accept(dto);
  }

  @Post()
  @Roles(...MANAGERS)
  @ApiOperation({
    summary: 'Invita a un empleado',
    description:
      'Crea la cuenta sin contraseña y devuelve el link de activación, que se ' +
      'muestra **una sola vez**. Valida el límite de empleados del plan.',
  })
  @ApiCreatedResponse({ type: EmployeeInvitationResponseDto })
  @ApiForbiddenResponse({
    description: 'Tu rol no puede invitar, o el plan llegó al límite',
  })
  @ApiConflictResponse({ description: 'Ese email ya tiene una cuenta' })
  invite(
    @Body() dto: InviteEmployeeDto,
  ): Promise<EmployeeInvitationResponseDto> {
    return this.employeesService.invite(dto);
  }

  @Get()
  @ApiOperation({ summary: 'Lista los empleados del negocio' })
  @ApiOkResponse({ type: [EmployeeResponseDto] })
  findAll(
    @Query() query: ListEmployeesQueryDto,
  ): Promise<EmployeeResponseDto[]> {
    return this.employeesService.findAll(query);
  }

  /**
   * Va declarado ANTES que `@Get(':id')`, si no `schedules` entra como `:id` y
   * el `ParseUUIDPipe` lo rechaza con un 400 que no dice nada. Mismo motivo que
   * `activate` arriba.
   */
  @Get('schedules')
  @ApiOperation({
    summary: 'Horario y ausencias de todo el equipo, en un pedido',
    description:
      'Existe para que la grilla del panel no arme una llamada por empleado. ' +
      'El horario semanal **no** depende del rango —es una plantilla por día ' +
      'de la semana—; `from`/`to` acotan las **ausencias**, y traen las que ' +
      'tocan el rango, no solo las que caen enteras adentro.\n\n' +
      'Con `branchId` vienen solo los tramos de esa sucursal, pero las ' +
      'ausencias **sin** sucursal entran igual: no estar en ninguna incluye a ' +
      'esta.\n\n' +
      '**No es la disponibilidad real.** Esto es lo que la persona declaró y ' +
      'lo que lo interrumpe; los turnos ya tomados, los recursos ocupados y el ' +
      'horario de la sucursal los descuenta `GET /appointments/availability`.',
  })
  @ApiOkResponse({ type: [TeamMemberScheduleDto] })
  @ApiBadRequestResponse({
    description:
      'Fechas mal formadas, rango invertido, de más de 92 días, o una ' +
      'sucursal que no es de tu negocio.',
  })
  findTeamSchedules(
    @Query() query: TeamScheduleQueryDto,
  ): Promise<TeamMemberScheduleDto[]> {
    return this.employeesService.findTeamSchedules(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Devuelve un empleado y sus sucursales' })
  @ApiOkResponse({ type: EmployeeDetailResponseDto })
  @ApiNotFoundResponse({ description: 'El empleado no existe' })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<EmployeeDetailResponseDto> {
    return this.employeesService.findOne(id);
  }

  @Patch(':id')
  @Roles(...MANAGERS)
  @ApiOperation({
    summary: 'Edita el vínculo del empleado con el negocio',
    description:
      'Rol, estado y datos laborales. Los datos personales (nombre, email) son ' +
      'de la cuenta del usuario y no se editan por acá.',
  })
  @ApiOkResponse({ type: EmployeeResponseDto })
  @ApiForbiddenResponse({
    description: 'Tu rol no puede editar empleados, o el empleado es el dueño',
  })
  @ApiNotFoundResponse({ description: 'El empleado no existe' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEmployeeDto,
  ): Promise<EmployeeResponseDto> {
    return this.employeesService.update(id, dto);
  }

  @Delete(':id')
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Da de baja a un empleado',
    description:
      'Baja lógica. Para cortarle el acceso sin sacarlo del historial, mejor ' +
      'desactivarlo con `PATCH { isActive: false }`.',
  })
  @ApiNoContentResponse({ description: 'Empleado dado de baja' })
  @ApiForbiddenResponse({
    description: 'Tu rol no puede dar de baja, o el empleado es el dueño',
  })
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.employeesService.remove(id);
  }

  @Post(':id/invitation')
  @Roles(...MANAGERS)
  @ApiOperation({
    summary: 'Reenvía la invitación',
    description:
      'Emite un link nuevo y revoca el anterior. Solo mientras el empleado no ' +
      'haya activado su cuenta.',
  })
  @ApiCreatedResponse({ type: EmployeeInvitationResponseDto })
  @ApiConflictResponse({ description: 'El empleado ya activó su cuenta' })
  @ApiNotFoundResponse({ description: 'El empleado no existe' })
  resendInvitation(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<EmployeeInvitationResponseDto> {
    return this.employeesService.resendInvitation(id);
  }

  @Put(':id/branches')
  @Roles(...MANAGERS)
  @ApiOperation({
    summary: 'Define en qué sucursales trabaja',
    description:
      'Reemplaza el set completo. Sacarle una sucursal borra también el ' +
      'horario que tuviera ahí.',
  })
  @ApiOkResponse({ type: [String] })
  @ApiBadRequestResponse({ description: 'Alguna sucursal no es de tu negocio' })
  @ApiForbiddenResponse({ description: 'Tu rol no puede asignar sucursales' })
  setBranches(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetEmployeeBranchesDto,
  ): Promise<string[]> {
    return this.employeesService.setBranches(id, dto);
  }

  @Get(':id/schedules')
  @ApiOperation({ summary: 'Devuelve el horario semanal del empleado' })
  @ApiOkResponse({ type: [EmployeeShiftResponseDto] })
  findSchedules(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<EmployeeShiftResponseDto[]> {
    return this.employeesService.findSchedules(id);
  }

  @Put(':id/schedules')
  @Roles(...MANAGERS)
  @ApiOperation({
    summary: 'Reemplaza el horario semanal completo',
    description:
      'Un tramo por franja de trabajo: dos tramos el mismo día son un turno ' +
      'partido, y un día sin tramos es un día que no trabaja. Los tramos no ' +
      'se pueden pisar entre sí, ni siquiera en sucursales distintas.',
  })
  @ApiOkResponse({ type: [EmployeeShiftResponseDto] })
  @ApiBadRequestResponse({
    description: 'Tramos superpuestos, mal formados o de una sucursal ajena',
  })
  @ApiForbiddenResponse({ description: 'Tu rol no puede editar horarios' })
  setSchedules(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetEmployeeSchedulesDto,
  ): Promise<EmployeeShiftResponseDto[]> {
    return this.employeesService.setSchedules(id, dto);
  }

  @Get(':id/time-off')
  @ApiOperation({
    summary: 'Lista las ausencias del empleado',
    description:
      'Con `from`/`to` devuelve las que se solapan con ese rango, no solo las ' +
      'que caen enteras adentro.',
  })
  @ApiOkResponse({ type: [TimeOffResponseDto] })
  findTimeOff(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListTimeOffQueryDto,
  ): Promise<TimeOffResponseDto[]> {
    return this.employeesService.findTimeOff(id, query);
  }

  @Post(':id/time-off')
  @Roles(...MANAGERS)
  @ApiOperation({
    summary: 'Carga vacaciones o una ausencia',
    description:
      '`kind` dice de qué clase es. Es opcional y sin él queda `OTHER`, pero ' +
      'mandarlo es lo que evita que el panel adivine la categoría leyendo el ' +
      '`reason`, que es texto libre.',
  })
  @ApiCreatedResponse({ type: TimeOffResponseDto })
  @ApiForbiddenResponse({ description: 'Tu rol no puede cargar ausencias' })
  createTimeOff(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateTimeOffDto,
  ): Promise<TimeOffResponseDto> {
    return this.employeesService.createTimeOff(id, dto);
  }

  @Delete(':id/time-off/:timeOffId')
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Borra una ausencia' })
  @ApiNoContentResponse({ description: 'Ausencia borrada' })
  @ApiForbiddenResponse({ description: 'Tu rol no puede borrar ausencias' })
  removeTimeOff(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('timeOffId', ParseUUIDPipe) timeOffId: string,
  ): Promise<void> {
    return this.employeesService.removeTimeOff(id, timeOffId);
  }
}
