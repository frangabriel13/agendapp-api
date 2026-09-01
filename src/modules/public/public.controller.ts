import { Controller, Get } from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PublicTenant } from '../../common/decorators/public-tenant.decorator';
import {
  PublicBranchDto,
  PublicServiceGroupDto,
} from './dto/public-catalog.dto';
import { PublicBusinessDto } from './dto/public-portal.dto';
import { PublicService } from './public.service';

/**
 * Más ajustado que el global (10/s, 100/min) porque acá no hay nadie
 * identificado: el único costo de pedir es tener una IP. Sigue siendo cómodo
 * para una persona navegando —abrir el portal son tres pedidos— y molesto para
 * quien quiera bajarse el catálogo de todos los negocios.
 */
const PORTAL_THROTTLE = {
  short: { limit: 5, ttl: 1_000 },
  long: { limit: 60, ttl: 60_000 },
};

/**
 * El portal público de un negocio: lo que ve alguien sin cuenta.
 *
 * **`@PublicTenant()` a nivel controller.** Es `@Public()` (sin access token)
 * más la resolución del negocio por el `:slug`: `PublicTenantGuard` lo monta en
 * el contexto antes del handler, así que el service trabaja con `prisma.scoped`
 * igual que el panel. Ponerlo en el controller y no método por método es a
 * propósito — una ruta del portal a la que se le olvide el decorador queda
 * pública **y sin tenant**, que es la combinación que expondría datos de todos
 * los negocios.
 *
 * Un slug que no existe, o de un negocio borrado, es **404 con el mismo
 * mensaje**: distinguirlos le diría a cualquiera qué slugs estuvieron tomados.
 */
@ApiTags('public')
@PublicTenant()
@Throttle(PORTAL_THROTTLE)
@ApiParam({ name: 'slug', example: 'peluqueria-ana' })
@ApiNotFoundResponse({ description: 'No existe un negocio con ese slug' })
@Controller('public/:slug')
export class PublicController {
  constructor(private readonly portal: PublicService) {}

  @Get()
  @ApiOperation({
    summary: 'El negocio: branding, zona horaria y reglas de reserva',
    description:
      'La primera llamada del portal. `booking` trae las reglas que el portal ' +
      'tiene que respetar —si toma reservas, la antelación mínima y hasta ' +
      'cuándo—, para que el calendario pueda deshabilitar los días que no van ' +
      'en vez de dejar que el visitante se coma un 400.',
  })
  @ApiOkResponse({ type: PublicBusinessDto })
  findBusiness(): Promise<PublicBusinessDto> {
    return this.portal.findBusiness();
  }

  @Get('branches')
  @ApiOperation({
    summary: 'Las sucursales activas, con su horario de atención',
    description:
      'Hace falta para reservar —el turno es en una sucursal— y de paso es lo ' +
      'que el portal muestra como dirección y teléfono.',
  })
  @ApiOkResponse({ type: [PublicBranchDto] })
  findBranches(): Promise<PublicBranchDto[]> {
    return this.portal.findBranches();
  }

  @Get('services')
  @ApiOperation({
    summary: 'Los servicios reservables, agrupados por categoría',
    description:
      'Solo los que están **activos y marcados como públicos**. Son dos ' +
      'condiciones distintas: un servicio puede existir y agendarse desde el ' +
      'panel sin que un desconocido pueda elegirlo solo.\n\n' +
      'Los que no tienen categoría vienen al final en un grupo `"Otros"` con ' +
      '`id: null`, no se esconden.',
  })
  @ApiOkResponse({ type: [PublicServiceGroupDto] })
  findServices(): Promise<PublicServiceGroupDto[]> {
    return this.portal.findServices();
  }
}
