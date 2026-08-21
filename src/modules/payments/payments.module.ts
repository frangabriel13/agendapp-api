import { Module } from '@nestjs/common';
import { AppointmentsModule } from '../appointments/appointments.module';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { PaymentProviderModule } from './payment-provider.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import { WebhooksController } from './webhooks.controller';

/**
 * Pagos de turnos, y el endpoint por donde entra todo aviso del proveedor.
 *
 * **No es `@Global`**, a diferencia de `MailModule`: cobrar es un dominio, no
 * infraestructura transversal.
 *
 * Importa `AppointmentsModule` porque **el estado de un turno lo escribe el
 * service de turnos**, incluso cuando el disparador es un pago. Y a
 * `SubscriptionsModule` porque el webhook es uno solo para los dos tipos de
 * cobro: el aviso llega sin decir de cuál es y hay que buscarlo en las dos
 * tablas. Las dos dependencias van en un solo sentido — ni turnos ni
 * suscripciones saben que existe este módulo.
 */
@Module({
  imports: [PaymentProviderModule, AppointmentsModule, SubscriptionsModule],
  controllers: [PaymentsController, WebhooksController],
  providers: [PaymentsService],
})
export class PaymentsModule {}
