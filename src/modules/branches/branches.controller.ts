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
import { Roles } from '../../common/decorators/roles.decorator';
import { BranchesService } from './branches.service';
import {
  BranchDetailResponseDto,
  BranchResponseDto,
  CreateBranchDto,
  ListBranchesQueryDto,
  UpdateBranchDto,
} from './dto/branch.dto';
import {
  BusinessHourResponseDto,
  SetBusinessHoursDto,
} from './dto/business-hours.dto';
import {
  CreateSpecialDayDto,
  ListSpecialDaysQueryDto,
  SpecialDayResponseDto,
  UpdateSpecialDayDto,
} from './dto/special-day.dto';

/** Abrir, editar o cerrar sucursales es cosa del dueño o de administración. */
const MANAGERS = [EmployeeRole.OWNER, EmployeeRole.ADMINISTRATIVE] as const;

/**
 * Las lecturas quedan abiertas a cualquier empleado autenticado: un profesional
 * necesita ver en qué sucursales trabaja y con qué horarios. Las escrituras van
 * con `@Roles`.
 */
@ApiTags('branches')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, vencido o inválido' })
@ApiNotFoundResponse({ description: 'La sucursal no existe' })
@Controller('branches')
export class BranchesController {
  constructor(private readonly branchesService: BranchesService) {}

  @Post()
  @Roles(...MANAGERS)
  @ApiOperation({
    summary: 'Crea una sucursal con su horario semanal',
    description:
      'Valida el límite de sucursales del plan. Si no se manda `businessHours`, ' +
      'la sucursal nace abierta de lunes a viernes de 09:00 a 18:00.',
  })
  @ApiCreatedResponse({ type: BranchDetailResponseDto })
  @ApiForbiddenResponse({
    description: 'Tu rol no puede crear sucursales, o el plan llegó al límite',
  })
  @ApiConflictResponse({ description: 'Ya existe una sucursal con ese nombre' })
  create(@Body() dto: CreateBranchDto): Promise<BranchDetailResponseDto> {
    return this.branchesService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'Lista las sucursales del negocio' })
  @ApiOkResponse({ type: [BranchResponseDto] })
  findAll(@Query() query: ListBranchesQueryDto): Promise<BranchResponseDto[]> {
    return this.branchesService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Devuelve una sucursal con su horario semanal' })
  @ApiOkResponse({ type: BranchDetailResponseDto })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BranchDetailResponseDto> {
    return this.branchesService.findOne(id);
  }

  @Patch(':id')
  @Roles(...MANAGERS)
  @ApiOperation({
    summary: 'Edita los datos de una sucursal',
    description:
      'El horario NO se edita acá: va por `PUT /branches/:id/business-hours`.',
  })
  @ApiOkResponse({ type: BranchResponseDto })
  @ApiForbiddenResponse({ description: 'Tu rol no puede editar sucursales' })
  @ApiConflictResponse({ description: 'Ya existe una sucursal con ese nombre' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBranchDto,
  ): Promise<BranchResponseDto> {
    return this.branchesService.update(id, dto);
  }

  @Delete(':id')
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Da de baja una sucursal',
    description:
      'Baja lógica. Para sacarla de la agenda sin perder el historial, mejor ' +
      'desactivarla con `PATCH { isActive: false }`.',
  })
  @ApiNoContentResponse({ description: 'Sucursal dada de baja' })
  @ApiForbiddenResponse({
    description: 'Tu rol no puede dar de baja sucursales',
  })
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.branchesService.remove(id);
  }

  @Get(':id/business-hours')
  @ApiOperation({ summary: 'Devuelve el horario semanal de la sucursal' })
  @ApiOkResponse({ type: [BusinessHourResponseDto] })
  findBusinessHours(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BusinessHourResponseDto[]> {
    return this.branchesService.findBusinessHours(id);
  }

  @Put(':id/business-hours')
  @Roles(...MANAGERS)
  @ApiOperation({
    summary: 'Reemplaza el horario semanal completo',
    description:
      'Hay que mandar los 7 días. Un día con `isClosed: true` va sin horas; ' +
      'uno abierto necesita `opensAt` y `closesAt`, y tiene que cerrar después ' +
      'de abrir.',
  })
  @ApiOkResponse({ type: [BusinessHourResponseDto] })
  @ApiForbiddenResponse({ description: 'Tu rol no puede editar los horarios' })
  setBusinessHours(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetBusinessHoursDto,
  ): Promise<BusinessHourResponseDto[]> {
    return this.branchesService.setBusinessHours(id, dto);
  }

  @Get(':id/special-days')
  @ApiOperation({
    summary: 'Lista los días especiales de la sucursal',
    description: 'Feriados y jornadas con horario distinto al de la semana.',
  })
  @ApiOkResponse({ type: [SpecialDayResponseDto] })
  findSpecialDays(
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: ListSpecialDaysQueryDto,
  ): Promise<SpecialDayResponseDto[]> {
    return this.branchesService.findSpecialDays(id, query);
  }

  @Post(':id/special-days')
  @Roles(...MANAGERS)
  @ApiOperation({ summary: 'Carga un feriado o una jornada especial' })
  @ApiCreatedResponse({ type: SpecialDayResponseDto })
  @ApiForbiddenResponse({
    description: 'Tu rol no puede cargar días especiales',
  })
  @ApiConflictResponse({ description: 'Esa fecha ya tiene un día especial' })
  createSpecialDay(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateSpecialDayDto,
  ): Promise<SpecialDayResponseDto> {
    return this.branchesService.createSpecialDay(id, dto);
  }

  @Patch(':id/special-days/:specialDayId')
  @Roles(...MANAGERS)
  @ApiOperation({
    summary: 'Edita un día especial',
    description:
      'La fecha no se edita: para moverlo de día, se borra y se carga de nuevo.',
  })
  @ApiOkResponse({ type: SpecialDayResponseDto })
  @ApiForbiddenResponse({
    description: 'Tu rol no puede editar días especiales',
  })
  updateSpecialDay(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('specialDayId', ParseUUIDPipe) specialDayId: string,
    @Body() dto: UpdateSpecialDayDto,
  ): Promise<SpecialDayResponseDto> {
    return this.branchesService.updateSpecialDay(id, specialDayId, dto);
  }

  @Delete(':id/special-days/:specialDayId')
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Borra un día especial' })
  @ApiNoContentResponse({ description: 'Día especial borrado' })
  @ApiForbiddenResponse({
    description: 'Tu rol no puede borrar días especiales',
  })
  removeSpecialDay(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('specialDayId', ParseUUIDPipe) specialDayId: string,
  ): Promise<void> {
    return this.branchesService.removeSpecialDay(id, specialDayId);
  }
}
