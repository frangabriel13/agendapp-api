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
import {
  CreateResourceDto,
  ListResourcesQueryDto,
  ResourceResponseDto,
  UpdateResourceDto,
} from './dto/resource.dto';
import { ResourcesService } from './resources.service';

/** Armar el catálogo es cosa del dueño o de administración. */
const MANAGERS = [EmployeeRole.OWNER, EmployeeRole.ADMINISTRATIVE] as const;

@ApiTags('resources')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, vencido o inválido' })
@ApiNotFoundResponse({ description: 'El recurso no existe' })
@Controller('resources')
export class ResourcesController {
  constructor(private readonly resourcesService: ResourcesService) {}

  @Post()
  @Roles(...MANAGERS)
  @ApiOperation({
    summary: 'Crea un recurso en una sucursal',
    description:
      'Camillas, sillones, salas. Requiere un plan que incluya recursos.',
  })
  @ApiCreatedResponse({ type: ResourceResponseDto })
  @ApiBadRequestResponse({ description: 'La sucursal no existe en tu negocio' })
  @ApiForbiddenResponse({
    description: 'Tu rol no puede crear recursos, o el plan no los incluye',
  })
  @ApiConflictResponse({
    description: 'Esa sucursal ya tiene un recurso con ese nombre',
  })
  create(@Body() dto: CreateResourceDto): Promise<ResourceResponseDto> {
    return this.resourcesService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'Lista los recursos del negocio' })
  @ApiOkResponse({ type: [ResourceResponseDto] })
  findAll(
    @Query() query: ListResourcesQueryDto,
  ): Promise<ResourceResponseDto[]> {
    return this.resourcesService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Devuelve un recurso' })
  @ApiOkResponse({ type: ResourceResponseDto })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ResourceResponseDto> {
    return this.resourcesService.findOne(id);
  }

  @Patch(':id')
  @Roles(...MANAGERS)
  @ApiOperation({
    summary: 'Edita un recurso',
    description:
      'La sucursal NO se cambia: un recurso mudado es, para la agenda, otro ' +
      'recurso. Dar de baja el viejo y crear uno nuevo.',
  })
  @ApiOkResponse({ type: ResourceResponseDto })
  @ApiForbiddenResponse({ description: 'Tu rol no puede editar recursos' })
  @ApiConflictResponse({
    description: 'Esa sucursal ya tiene un recurso con ese nombre',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateResourceDto,
  ): Promise<ResourceResponseDto> {
    return this.resourcesService.update(id, dto);
  }

  @Delete(':id')
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Da de baja un recurso',
    description:
      'Baja lógica. Para sacarlo de la reserva sin perder el historial, mejor ' +
      'desactivarlo con `PATCH { isActive: false }`.',
  })
  @ApiNoContentResponse({ description: 'Recurso dado de baja' })
  @ApiForbiddenResponse({ description: 'Tu rol no puede dar de baja recursos' })
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.resourcesService.remove(id);
  }
}
