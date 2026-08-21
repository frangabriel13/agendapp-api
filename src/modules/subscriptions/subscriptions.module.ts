import { Module } from '@nestjs/common';
import { PaymentProviderModule } from '../payments/payment-provider.module';
import { SubscriptionsController } from './subscriptions.controller';
import { SubscriptionsCron } from './subscriptions.cron';
import { SubscriptionsService } from './subscriptions.service';

/**
 * La suscripción del negocio a AgendApp.
 *
 * Importa **solo el proveedor de pagos**, no `PaymentsModule`: al revés se
 * cerraría un ciclo, porque pagos necesita este módulo para rutear el webhook.
 *
 * Exporta el service para dos consumidores de afuera: el `WebhooksController`
 * (que rutea el aviso a la tabla correcta) y el `ActiveSubscriptionGuard`, que
 * está montado como guard global en `AppModule`.
 */
@Module({
  imports: [PaymentProviderModule],
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService, SubscriptionsCron],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
