import { Module } from '@nestjs/common';
import { PublicController } from './public.controller';
import { PublicService } from './public.service';

/**
 * El portal público. No importa nada: `PrismaModule` y `TenantContextModule`
 * son globales, y el negocio lo resuelve `PublicTenantGuard`, que vive en la
 * cadena global de `AppModule`.
 */
@Module({
  controllers: [PublicController],
  providers: [PublicService],
})
export class PublicModule {}
