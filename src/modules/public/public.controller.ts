import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { PublicTenant } from '../../common/decorators/public-tenant.decorator';
import { RequiresActiveSubscription } from '../../common/decorators/requires-active-subscription.decorator';
import {
  AvailabilityQueryDto,
  AvailabilityResponseDto,
} from '../appointments/dto/availability.dto';
import {
  CreatePublicBookingDto,
  PublicBookingResponseDto,
} from './dto/public-booking.dto';
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
 * El del `POST` es mucho más duro que el de los `GET`, y no por el costo de
 * servirlo: cada reserva **le ocupa un hueco al negocio**. Sin un límite propio,
 * alguien le llena la agenda de la semana con teléfonos inventados y el límite
 * de lectura ni se entera, porque cincuenta reservas son cincuenta pedidos.
 *
 * Quince por hora deja pasar a una familia reservando desde la misma casa y no
 * a un script. **No alcanza solo** —las IPs son baratas—; es la primera capa,
 * y la que de verdad limita el daño es que un turno sin seña pagada se libera
 * a los `ABANDONED_HOLD_MINUTES`.
 */
const BOOKING_THROTTLE = {
  short: { limit: 3, ttl: 60_000 },
  long: { limit: 15, ttl: 3_600_000 },
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

  @Get('availability')
  @ApiOperation({
    summary: 'Los horarios libres de un día',
    description:
      'El mismo cálculo que usa el panel, **recortado a la ventana de reserva** ' +
      'del negocio: nada antes de la antelación mínima ni después del último ' +
      'día permitido.\n\n' +
      'Un día fuera de la ventana devuelve `slots: []`, no un error: el portal ' +
      'ya sabe la ventana por `GET /public/:slug` y puede deshabilitar esos ' +
      'días, y un 400 rompería la vista de un mes entero.\n\n' +
      'Cada slot trae `employees[]`: son los que tienen ese hueco libre. Si ' +
      'quien reserva no quiere elegir, se manda el turno sin `employeeId`.',
  })
  @ApiOkResponse({ type: AvailabilityResponseDto })
  @ApiForbiddenResponse({
    description: 'El negocio no toma reservas por la web',
  })
  findAvailability(
    @Query() query: AvailabilityQueryDto,
  ): Promise<AvailabilityResponseDto> {
    return this.portal.findAvailability(query);
  }

  @Post('appointments')
  @Throttle(BOOKING_THROTTLE)
  @RequiresActiveSubscription()
  @ApiOperation({
    summary: 'Reservar un turno',
    description:
      'Sin cuenta y sin token. A la persona se la identifica por el **teléfono**: ' +
      'si ya es clienta del negocio se usa su ficha y si no se crea una, y **la ' +
      'respuesta es idéntica en los dos casos** — distinguirlas convertiría ' +
      'esto en un buscador de clientela ajena.\n\n' +
      '`employeeId` es opcional: sin él lo elige el servidor entre los que ' +
      'tienen el hueco libre.\n\n' +
      'Si los servicios tienen seña, el turno nace **esperando el pago** y la ' +
      'respuesta trae `deposit.checkoutUrl`. Hasta que la seña entre el turno ' +
      'no está tomado: se libera solo si nadie paga. Acá no se mira ' +
      '`requireDepositForBooking` — ese setting es para el mostrador.',
  })
  @ApiCreatedResponse({ type: PublicBookingResponseDto })
  @ApiForbiddenResponse({
    description: 'El negocio no toma reservas por la web',
  })
  @ApiConflictResponse({ description: 'Ese horario ya no está disponible' })
  @ApiBadGatewayResponse({
    description:
      'No se pudo generar el link de pago. El turno queda reservado sin pagar ' +
      'y se libera solo: se puede reintentar.',
  })
  book(@Body() dto: CreatePublicBookingDto): Promise<PublicBookingResponseDto> {
    return this.portal.book(dto);
  }
}
