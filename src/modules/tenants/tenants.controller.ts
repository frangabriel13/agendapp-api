import { Body, Controller, Get, Patch } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { EmployeeRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  TenantBrandingResponseDto,
  UpdateTenantBrandingDto,
} from './dto/tenant-branding.dto';
import { TenantResponseDto } from './dto/tenant-response.dto';
import {
  TenantSettingsResponseDto,
  UpdateTenantSettingsDto,
} from './dto/tenant-settings.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';
import { TenantsService } from './tenants.service';

/** Editar la configuración del negocio es cosa del dueño o de administración. */
const MANAGERS = [EmployeeRole.OWNER, EmployeeRole.ADMINISTRATIVE] as const;

@ApiTags('tenants')
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Token ausente, vencido o inválido' })
@Controller('tenants')
export class TenantsController {
  constructor(private readonly tenantsService: TenantsService) {}

  @Get('me')
  @ApiOperation({
    summary: 'Devuelve el negocio del usuario logueado',
    description: 'Incluye el plan contratado y sus límites.',
  })
  @ApiOkResponse({ type: TenantResponseDto })
  findMine(): Promise<TenantResponseDto> {
    return this.tenantsService.findMine();
  }

  @Patch('me')
  @Roles(...MANAGERS)
  @ApiOperation({
    summary: 'Edita los datos del negocio',
    description:
      'El `slug` no se edita acá: es la URL pública del portal de reservas.',
  })
  @ApiOkResponse({ type: TenantResponseDto })
  @ApiForbiddenResponse({ description: 'Tu rol no puede editar el negocio' })
  updateMine(@Body() dto: UpdateTenantDto): Promise<TenantResponseDto> {
    return this.tenantsService.updateMine(dto);
  }

  @Get('me/branding')
  @ApiOperation({ summary: 'Devuelve la personalización del portal público' })
  @ApiOkResponse({ type: TenantBrandingResponseDto })
  @ApiNotFoundResponse({ description: 'El negocio no tiene branding cargado' })
  findBranding(): Promise<TenantBrandingResponseDto> {
    return this.tenantsService.findBranding();
  }

  @Patch('me/branding')
  @Roles(...MANAGERS)
  @ApiOperation({
    summary: 'Edita la personalización del portal público',
    description:
      'Los campos nullables se borran mandando `null`; omitirlos los deja como están.',
  })
  @ApiOkResponse({ type: TenantBrandingResponseDto })
  @ApiForbiddenResponse({ description: 'Tu rol no puede editar el branding' })
  updateBranding(
    @Body() dto: UpdateTenantBrandingDto,
  ): Promise<TenantBrandingResponseDto> {
    return this.tenantsService.updateBranding(dto);
  }

  @Get('me/settings')
  @ApiOperation({ summary: 'Devuelve la configuración operativa del negocio' })
  @ApiOkResponse({ type: TenantSettingsResponseDto })
  @ApiNotFoundResponse({
    description: 'El negocio no tiene configuración cargada',
  })
  findSettings(): Promise<TenantSettingsResponseDto> {
    return this.tenantsService.findSettings();
  }

  @Patch('me/settings')
  @Roles(...MANAGERS)
  @ApiOperation({
    summary: 'Edita la configuración operativa del negocio',
    description:
      'Política de cancelación, seña obligatoria y buffer por defecto entre turnos.',
  })
  @ApiOkResponse({ type: TenantSettingsResponseDto })
  @ApiForbiddenResponse({
    description: 'Tu rol no puede editar la configuración',
  })
  updateSettings(
    @Body() dto: UpdateTenantSettingsDto,
  ): Promise<TenantSettingsResponseDto> {
    return this.tenantsService.updateSettings(dto);
  }
}
