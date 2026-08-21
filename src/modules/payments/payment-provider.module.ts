import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';
import { MercadoPagoProvider } from './providers/mercadopago.provider';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
} from './providers/payment-provider.types';
import { SandboxPaymentProvider } from './providers/sandbox-payment.provider';

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
 * Solo el proveedor, en su propio módulo.
 *
 * Está separado de `PaymentsModule` porque lo necesitan dos dominios distintos
 * —cobrarle a un cliente por un turno, y cobrarle al negocio su suscripción— y
 * si viviera adentro de uno de los dos, el otro tendría que importarlo entero.
 * Eso cerraba un ciclo: `PaymentsModule` necesita a suscripciones para rutear
 * el webhook, y suscripciones necesitaba el proveedor de pagos.
 */
@Module({
  providers: [
    {
      provide: PAYMENT_PROVIDER,
      inject: [ConfigService],
      useFactory: createPaymentProvider,
    },
  ],
  exports: [PAYMENT_PROVIDER],
})
export class PaymentProviderModule {}
