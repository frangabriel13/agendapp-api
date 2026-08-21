import { Controller, Get, Post } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { EmployeeRole } from '@prisma/client';
import { Roles } from '../../common/decorators/roles.decorator';
import {
  SubscriptionCheckoutDto,
  SubscriptionDto,
} from './dto/subscription.dto';
import { SubscriptionsService } from './subscriptions.service';

/**
 * La suscripción del negocio a AgendApp.
 *
 * **Con `@Roles`**, a diferencia de los cobros de turnos: esto no es trabajo de
 * mostrador, es la cuenta del negocio. Un profesional no tiene por qué ver
 * cuánto paga su empleador ni poder gatillar un cobro.
 *
 * Cuelga de `/tenants/me` porque es configuración del negocio, no un recurso
 * aparte: un tenant tiene una suscripción y solo puede ver la suya.
 */
@ApiTags('subscriptions')
@ApiBearerAuth()
@Roles(EmployeeRole.OWNER, EmployeeRole.ADMINISTRATIVE)
@Controller('tenants/me/subscription')
export class SubscriptionsController {
  constructor(private readonly subscriptions: SubscriptionsService) {}

  @Get()
  @ApiOperation({
    summary: 'Estado de la suscripción y su historial de cobros',
    description:
      '`blocked` dice si el negocio ya no puede agendar. Deber no alcanza: ' +
      'hay que pasar los `graceDays` de tolerancia.',
  })
  @ApiOkResponse({ type: SubscriptionDto })
  findCurrent(): Promise<SubscriptionDto> {
    return this.subscriptions.findCurrent();
  }

  @Post('checkout')
  @ApiOperation({
    summary: 'Genera el link para pagar el mes',
    description:
      'Pedirlo dos veces devuelve el mismo link (`reused: true`) en vez de ' +
      'generar dos cobros del mismo período. La suscripción se reactiva cuando ' +
      'llega el aviso del proveedor, no acá.',
  })
  @ApiCreatedResponse({ type: SubscriptionCheckoutDto })
  @ApiConflictResponse({
    description: 'El plan se cotiza con soporte y no se paga desde el panel',
  })
  @ApiBadGatewayResponse({ description: 'El proveedor de pagos no respondió' })
  createCheckout(): Promise<SubscriptionCheckoutDto> {
    return this.subscriptions.createCheckout();
  }
}
