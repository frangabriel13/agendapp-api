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
import { CustomerTagsService } from './customer-tags.service';
import {
  CreateCustomerTagDto,
  CustomerTagResponseDto,
  UpdateCustomerTagDto,
} from './dto/customer-tag.dto';

/** Definir la segmentación es cosa del dueño o de administración. */
const MANAGERS = [EmployeeRole.OWNER, EmployeeRole.ADMINISTRATIVE] as const;

@ApiTags('customer-tags')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, vencido o inválido' })
@ApiNotFoundResponse({ description: 'La etiqueta no existe' })
@Controller('customer-tags')
export class CustomerTagsController {
  constructor(private readonly customerTagsService: CustomerTagsService) {}

  @Post()
  @Roles(...MANAGERS)
  @ApiOperation({
    summary: 'Crea una etiqueta de clientes',
    description: '"VIP", "Debe seña", "Alérgica al amoníaco".',
  })
  @ApiCreatedResponse({ type: CustomerTagResponseDto })
  @ApiForbiddenResponse({ description: 'Tu rol no puede crear etiquetas' })
  @ApiConflictResponse({ description: 'Ya tenés una etiqueta con ese nombre' })
  create(@Body() dto: CreateCustomerTagDto): Promise<CustomerTagResponseDto> {
    return this.customerTagsService.create(dto);
  }

  @Get()
  @ApiOperation({
    summary: 'Lista las etiquetas del negocio',
    description:
      'Alfabético, con cuántos clientes vivos tiene cada una. Sin paginar: ' +
      'son pocas por definición.',
  })
  @ApiOkResponse({ type: [CustomerTagResponseDto] })
  findAll(): Promise<CustomerTagResponseDto[]> {
    return this.customerTagsService.findAll();
  }

  @Get(':id')
  @ApiOperation({ summary: 'Devuelve una etiqueta' })
  @ApiOkResponse({ type: CustomerTagResponseDto })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CustomerTagResponseDto> {
    return this.customerTagsService.findOne(id);
  }

  @Patch(':id')
  @Roles(...MANAGERS)
  @ApiOperation({ summary: 'Edita una etiqueta' })
  @ApiOkResponse({ type: CustomerTagResponseDto })
  @ApiForbiddenResponse({ description: 'Tu rol no puede editar etiquetas' })
  @ApiConflictResponse({ description: 'Ya tenés una etiqueta con ese nombre' })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerTagDto,
  ): Promise<CustomerTagResponseDto> {
    return this.customerTagsService.update(id, dto);
  }

  @Delete(':id')
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Da de baja una etiqueta',
    description:
      'Se la saca de todos los clientes que la tenían. Mirá `customerCount` ' +
      'antes de llamar: conviene avisar si está en uso.',
  })
  @ApiNoContentResponse({ description: 'Etiqueta dada de baja' })
  @ApiForbiddenResponse({ description: 'Tu rol no puede borrar etiquetas' })
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.customerTagsService.remove(id);
  }
}
