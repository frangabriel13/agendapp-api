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
import {
  ServiceEmployeeResponseDto,
  SetServiceEmployeesDto,
} from './dto/employee-service.dto';
import {
  ServiceResourceResponseDto,
  SetServiceResourcesDto,
} from './dto/service-resource.dto';
import {
  CreateServiceDto,
  ListServicesQueryDto,
  ServiceResponseDto,
  UpdateServiceDto,
} from './dto/service.dto';
import { ServicesService } from './services.service';

/** Armar el catálogo es cosa del dueño o de administración. */
const MANAGERS = [EmployeeRole.OWNER, EmployeeRole.ADMINISTRATIVE] as const;

/**
 * Las lecturas quedan abiertas a cualquier empleado autenticado: un profesional
 * necesita ver qué servicios presta y cuánto duran. Las escrituras van con
 * `@Roles`.
 */
@ApiTags('services')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, vencido o inválido' })
@ApiNotFoundResponse({ description: 'El servicio no existe' })
@Controller('services')
export class ServicesController {
  constructor(private readonly servicesService: ServicesService) {}

  @Post()
  @Roles(...MANAGERS)
  @ApiOperation({
    summary: 'Crea un servicio',
    description:
      'El precio y la seña van en **centavos**. La duración y el buffer son ' +
      'los que la agenda va a usar para armar los slots.',
  })
  @ApiCreatedResponse({ type: ServiceResponseDto })
  @ApiBadRequestResponse({
    description: 'La categoría no existe, o la seña supera al precio',
  })
  @ApiForbiddenResponse({ description: 'Tu rol no puede crear servicios' })
  create(@Body() dto: CreateServiceDto): Promise<ServiceResponseDto> {
    return this.servicesService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'Lista los servicios del negocio' })
  @ApiOkResponse({ type: [ServiceResponseDto] })
  findAll(@Query() query: ListServicesQueryDto): Promise<ServiceResponseDto[]> {
    return this.servicesService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Devuelve un servicio' })
  @ApiOkResponse({ type: ServiceResponseDto })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<ServiceResponseDto> {
    return this.servicesService.findOne(id);
  }

  @Patch(':id')
  @Roles(...MANAGERS)
  @ApiOperation({
    summary: 'Edita un servicio',
    description:
      'Quién lo presta NO se edita acá: va por `PUT /services/:id/employees`.',
  })
  @ApiOkResponse({ type: ServiceResponseDto })
  @ApiBadRequestResponse({
    description: 'La categoría no existe, o la seña supera al precio',
  })
  @ApiForbiddenResponse({ description: 'Tu rol no puede editar servicios' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateServiceDto,
  ): Promise<ServiceResponseDto> {
    return this.servicesService.update(id, dto);
  }

  @Delete(':id')
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Da de baja un servicio',
    description:
      'Baja lógica. Para sacarlo de la reserva sin perder el historial, mejor ' +
      'desactivarlo con `PATCH { isActive: false }`.',
  })
  @ApiNoContentResponse({ description: 'Servicio dado de baja' })
  @ApiForbiddenResponse({
    description: 'Tu rol no puede dar de baja servicios',
  })
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.servicesService.remove(id);
  }

  @Get(':id/employees')
  @ApiOperation({ summary: 'Quién presta el servicio y en qué sucursal' })
  @ApiOkResponse({ type: [ServiceEmployeeResponseDto] })
  findEmployees(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ServiceEmployeeResponseDto[]> {
    return this.servicesService.findEmployees(id);
  }

  @Put(':id/employees')
  @Roles(...MANAGERS)
  @ApiOperation({
    summary: 'Define quién presta el servicio y dónde',
    description:
      'Reemplaza la lista completa. Cada empleado tiene que estar asignado a ' +
      'la sucursal que se le indica (`PUT /employees/:id/branches`).',
  })
  @ApiOkResponse({ type: [ServiceEmployeeResponseDto] })
  @ApiBadRequestResponse({
    description:
      'Hay asignaciones repetidas, o un empleado que no trabaja en esa sucursal',
  })
  @ApiForbiddenResponse({ description: 'Tu rol no puede editar el catálogo' })
  setEmployees(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetServiceEmployeesDto,
  ): Promise<ServiceEmployeeResponseDto[]> {
    return this.servicesService.setEmployees(id, dto);
  }

  @Get(':id/resources')
  @ApiOperation({ summary: 'Qué recursos necesita el servicio' })
  @ApiOkResponse({ type: [ServiceResourceResponseDto] })
  findResources(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ServiceResourceResponseDto[]> {
    return this.servicesService.findResources(id);
  }

  @Put(':id/resources')
  @Roles(...MANAGERS)
  @ApiOperation({
    summary: 'Define qué recursos necesita el servicio',
    description:
      'Reemplaza la lista completa. No se valida contra las sucursales donde ' +
      'se presta: esa intersección la resuelve la disponibilidad.',
  })
  @ApiOkResponse({ type: [ServiceResourceResponseDto] })
  @ApiBadRequestResponse({
    description: 'Hay recursos repetidos, o alguno no existe en tu negocio',
  })
  @ApiForbiddenResponse({ description: 'Tu rol no puede editar el catálogo' })
  setResources(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetServiceResourcesDto,
  ): Promise<ServiceResourceResponseDto[]> {
    return this.servicesService.setResources(id, dto);
  }
}
