import { Module } from '@nestjs/common';
import { AppointmentsModule } from '../appointments/appointments.module';
import { PaymentsModule } from '../payments/payments.module';
import { PublicController } from './public.controller';
import { PublicService } from './public.service';

/**
 * El portal público.
 *
 * Importa turnos y pagos porque **reserva con los mismos services que el
 * panel**: el portal no tiene su propia forma de agendar ni de cobrar, solo una
 * puerta distinta. Las dependencias van en un solo sentido — ni turnos ni pagos
 * saben que este módulo existe.
 *
 * `PrismaModule`, `TenantContextModule` y `MailModule` son globales, y el
 * negocio lo resuelve `PublicTenantGuard`, que vive en la cadena global de
 * `AppModule`.
 */
@Module({
  imports: [AppointmentsModule, PaymentsModule],
  controllers: [PublicController],
  providers: [PublicService],
})
export class PublicModule {}
