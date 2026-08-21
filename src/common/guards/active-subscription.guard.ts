import {
  type CanActivate,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SubscriptionsService } from '../../modules/subscriptions/subscriptions.service';
import { REQUIRES_ACTIVE_SUBSCRIPTION } from '../decorators/requires-active-subscription.decorator';
import { TenantContextService } from '../tenant-context';

/**
 * Corta las acciones marcadas con `@RequiresActiveSubscription()` cuando el
 * negocio hace rato que no paga.
 *
 * Va **después** de `JwtAuthGuard` en la cadena global: necesita el tenant ya
 * resuelto en el contexto. En una ruta sin tenant (pública, o el propio
 * endpoint de pago de la suscripción) no hay nada que chequear y deja pasar.
 *
 * Responde **402 Payment Required**, no 403. Los dos son "no podés", pero un
 * 403 se confunde con un problema de permisos: el 402 le dice al frontend, sin
 * leer el mensaje, que lo que hay que hacer es pagar. Es exactamente el caso
 * para el que existe ese código.
 */
@Injectable()
export class ActiveSubscriptionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tenantContext: TenantContextService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean>(
      REQUIRES_ACTIVE_SUBSCRIPTION,
      [context.getHandler(), context.getClass()],
    );

    if (!required) {
      return true;
    }

    const tenantId = this.tenantContext.getTenantId();

    if (!tenantId) {
      return true;
    }

    if (await this.subscriptions.isBlocked(tenantId)) {
      throw new HttpException(
        'La suscripción está vencida: no se pueden agendar turnos nuevos ' +
          'hasta regularizar el pago. La agenda que ya tenías sigue disponible.',
        HttpStatus.PAYMENT_REQUIRED,
      );
    }

    return true;
  }
}
