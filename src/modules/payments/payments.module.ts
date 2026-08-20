import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';
import { AppointmentsModule } from '../appointments/appointments.module';
import { PaymentsController } from './payments.controller';
import { PaymentsService } from './payments.service';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
} from './providers/payment-provider.types';
import { MercadoPagoProvider } from './providers/mercadopago.provider';
import { SandboxPaymentProvider } from './providers/sandbox-payment.provider';
import { WebhooksController } from './webhooks.controller';

/**
 * Elige el proveedor **al arrancar**, no en cada cobro: si las credenciales
 * están mal, la app no levanta, en vez de descubrirlo con un cliente esperando
 * en el checkout.
 *
 * `envSchema` ya garantiza que con `mercadopago` hay token y secreto de
 * webhook, así que acá no hace falta volver a validarlo.
 */
function createPaymentProvider(
  config: ConfigService<Env, true>,
): PaymentProvider {
  if (config.get('PAYMENT_PROVIDER', { infer: true }) === 'mercadopago') {
    return new MercadoPagoProvider(
      config.get('MP_ACCESS_TOKEN', { infer: true }),
      config.get('MP_WEBHOOK_SECRET', { infer: true }),
    );
  }

  return new SandboxPaymentProvider();
}

/**
 * Pagos de turnos.
 *
 * **No es `@Global`**, a diferencia de `MailModule`: cobrar es un dominio, no
 * infraestructura transversal.
 *
 * Importa `AppointmentsModule` porque **el estado de un turno lo escribe el
 * service de turnos**, incluso cuando el disparador es un pago. La dependencia
 * va en un solo sentido: turnos no sabe que existen los pagos.
 */
@Module({
  imports: [AppointmentsModule],
  controllers: [PaymentsController, WebhooksController],
  providers: [
    {
      provide: PAYMENT_PROVIDER,
      inject: [ConfigService],
      useFactory: createPaymentProvider,
    },
    PaymentsService,
  ],
  exports: [PAYMENT_PROVIDER],
})
export class PaymentsModule {}
