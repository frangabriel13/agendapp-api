import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../config/env.schema';
import { MailService } from './mail.service';
import { MAIL_PROVIDER, type MailProvider } from './mail.types';
import { LogMailProvider } from './providers/log-mail.provider';
import { ResendMailProvider } from './providers/resend-mail.provider';

/**
 * Elige el proveedor **una vez, al arrancar**, y no en cada envío: si la config
 * está mal, la app no levanta, en vez de descubrirlo el día que alguien pide un
 * reset de contraseña.
 *
 * `envSchema` ya garantiza que si `MAIL_PROVIDER=resend` hay una API key, así
 * que acá no hace falta volver a validarlo.
 */
function createMailProvider(config: ConfigService<Env, true>): MailProvider {
  if (config.get('MAIL_PROVIDER', { infer: true }) === 'resend') {
    return new ResendMailProvider(
      config.get('RESEND_API_KEY', { infer: true }),
      config.get('MAIL_FROM', { infer: true }),
    );
  }

  return new LogMailProvider();
}

/**
 * `@Global()` por el mismo motivo que `PrismaModule`: es infraestructura
 * transversal, no un dominio. Auth y Empleados lo usan hoy, y turnos y pagos lo
 * van a usar mañana. **No lo importes en un feature module** — inyectá
 * `MailService` directo.
 */
@Global()
@Module({
  providers: [
    {
      provide: MAIL_PROVIDER,
      inject: [ConfigService],
      useFactory: createMailProvider,
    },
    MailService,
  ],
  exports: [MailService],
})
export class MailModule {}
