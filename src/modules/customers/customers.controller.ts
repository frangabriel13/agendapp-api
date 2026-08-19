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
import { Roles } from '../../common/decorators/roles.decorator';
import { CustomersService } from './customers.service';
import {
  CreateCustomerDto,
  CustomerResponseDto,
  CustomerTagSummaryDto,
  DuplicateCustomerDto,
  ListCustomersQueryDto,
  PaginatedCustomersDto,
  SetCustomerTagsDto,
} from './dto/customer.dto';
import { UpdateCustomerDto } from './dto/customer.dto';

/**
 * Dar de baja una ficha sí es cosa de quien manda: es la única operación que
 * saca información de circulación. Cargar y editar clientes lo hace cualquier
 * empleado — quien atiende el mostrador no siempre es administrativo, y pedirle
 * permiso a alguien para anotar un teléfono sería absurdo.
 */
const MANAGERS = [EmployeeRole.OWNER, EmployeeRole.ADMINISTRATIVE] as const;

@ApiTags('customers')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, vencido o inválido' })
@ApiNotFoundResponse({ description: 'El cliente no existe' })
@Controller('customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) {}

  @Post()
  @ApiOperation({
    summary: 'Da de alta un cliente',
    description:
      'Si el teléfono ya está cargado en el negocio, responde **409** con la ' +
      'ficha existente en `existingCustomer` y no crea nada. No hay merge ' +
      'automático a propósito: dos personas pueden compartir teléfono, así ' +
      'que la decisión es del mostrador. Con ese cuerpo alcanza para ofrecer ' +
      '"¿es esta persona?" sin ir a buscarla con otra request.',
  })
  @ApiCreatedResponse({ type: CustomerResponseDto })
  @ApiBadRequestResponse({ description: 'Datos inválidos' })
  @ApiConflictResponse({
    type: DuplicateCustomerDto,
    description: 'Ya existe un cliente con ese teléfono',
  })
  create(@Body() dto: CreateCustomerDto): Promise<CustomerResponseDto> {
    return this.customersService.create(dto);
  }

  @Get()
  @ApiOperation({
    summary: 'Busca clientes, paginado',
    description:
      '`search` cruza nombre, apellido, email y teléfono. Los teléfonos se ' +
      'comparan normalizados, así que da igual cómo se tipeen. Pedir una ' +
      'página más allá del final devuelve `data: []`, no un 404.',
  })
  @ApiOkResponse({ type: PaginatedCustomersDto })
  findAll(
    @Query() query: ListCustomersQueryDto,
  ): Promise<PaginatedCustomersDto> {
    return this.customersService.findAll(query);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Devuelve un cliente con sus etiquetas' })
  @ApiOkResponse({ type: CustomerResponseDto })
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CustomerResponseDto> {
    return this.customersService.findOne(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Edita un cliente',
    description:
      'El teléfono se puede cambiar, pero pasa por el mismo chequeo que el ' +
      'alta: si el número nuevo ya es de otra ficha, 409.',
  })
  @ApiOkResponse({ type: CustomerResponseDto })
  @ApiConflictResponse({
    type: DuplicateCustomerDto,
    description: 'Otro cliente ya tiene ese teléfono',
  })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto,
  ): Promise<CustomerResponseDto> {
    return this.customersService.update(id, dto);
  }

  @Delete(':id')
  @Roles(...MANAGERS)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Da de baja un cliente',
    description:
      'Baja lógica: el historial de turnos queda. Libera el teléfono para una ' +
      'ficha nueva.',
  })
  @ApiNoContentResponse({ description: 'Cliente dado de baja' })
  @ApiForbiddenResponse({ description: 'Tu rol no puede dar de baja clientes' })
  remove(@Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.customersService.remove(id);
  }

  @Get(':id/tags')
  @ApiOperation({ summary: 'Etiquetas puestas a un cliente' })
  @ApiOkResponse({ type: [CustomerTagSummaryDto] })
  findTags(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<CustomerTagSummaryDto[]> {
    return this.customersService.findTags(id);
  }

  @Put(':id/tags')
  @ApiOperation({
    summary: 'Reemplaza las etiquetas de un cliente',
    description:
      'Se manda el set completo, no un delta: lo que no está en `tagIds` se ' +
      'saca. `[]` deja al cliente sin etiquetas.',
  })
  @ApiOkResponse({ type: [CustomerTagSummaryDto] })
  @ApiBadRequestResponse({
    description: 'Hay etiquetas repetidas, o alguna no existe en tu negocio',
  })
  setTags(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetCustomerTagsDto,
  ): Promise<CustomerTagSummaryDto[]> {
    return this.customersService.setTags(id, dto);
  }
}
