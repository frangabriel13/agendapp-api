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
import {
  CreateServiceCategoryDto,
  ServiceCategoryResponseDto,
  UpdateServiceCategoryDto,
} from './dto/service-category.dto';
import { ServiceCategoriesService } from './service-categories.service';

/** Armar el catálogo es cosa del dueño o de administración. */
const MANAGERS = [EmployeeRole.OWNER, EmployeeRole.ADMINISTRATIVE] as const;

/**
 * Mismo criterio que en sucursales: leer queda abierto a cualquier empleado
 * autenticado —un profesional necesita ver el catálogo— y escribir va con
 * `@Roles`.
 */
@ApiTags('service-categories')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, vencido o inválido' })
@ApiNotFoundResponse({ description: 'La categoría no existe' })
@Controller('service-categories')
export class ServiceCategoriesController {
  constructor(
    private readonly serviceCategoriesService: ServiceCategoriesService,
  ) {}

  @Post()
  @Roles(...MANAGERS)
  @ApiOperation({ summary: 'Crea una categoría de servicios' })
  @ApiCreatedResponse({ type: ServiceCategoryResponseDto })
  @ApiForbiddenResponse({ description: 'Tu rol no puede crear categorías' })
  @ApiConflictResponse({
    description: 'Ya existe una categoría con ese nombre',
  })
  create(
    @Body() dto: CreateServiceCategoryDto,
  ): Promise<ServiceCategoryResponseDto> {
    return this.serviceCategoriesService.create(dto);
  }

  @Get()
  @ApiOperation({
    summary: 'Lista las categorías del negocio',
    description: 'Ordenadas por `displayOrder` y, a igual valor, alfabético.',
  })
  @ApiOkResponse({ type: [ServiceCategoryResponseDto] })
  findAll(): Promise<ServiceCategoryResponseDto[]> {
    return this.serviceCategoriesService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Devuelve una categoría' })
  @ApiOkResponse({ type: ServiceCategoryResponseDto })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<ServiceCategoryResponseDto> {
    return this.serviceCategoriesService.findOne(id);
  }

  @Patch(':id')
  @Roles(...MANAGERS)
  @ApiOperation({ summary: 'Edita una categoría' })
  @ApiOkResponse({ type: ServiceCategoryResponseDto })
  @ApiForbiddenResponse({ description: 'Tu rol no puede editar categorías' })
  @ApiConflictResponse({
    description: 'Ya existe una categoría con ese nombre',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateServiceCategoryDto,
  ): Promise<ServiceCategoryResponseDto> {
    return this.serviceCategoriesService.update(id, dto);
  }

  @Delete(':id')
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Da de baja una categoría',
    description:
      'Baja lógica. Los servicios de la categoría NO se borran: quedan sin ' +
      'categoría y se los puede reasignar.',
  })
  @ApiNoContentResponse({ description: 'Categoría dada de baja' })
  @ApiForbiddenResponse({
    description: 'Tu rol no puede dar de baja categorías',
  })
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.serviceCategoriesService.remove(id);
  }
}
