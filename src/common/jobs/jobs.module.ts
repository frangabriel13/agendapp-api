import { Global, Module } from '@nestjs/common';
import { JobLockService } from './job-lock.service';

/**
 * `@Global` como `PrismaModule`: el lock lo necesita cualquier módulo que
 * tenga un `@Cron`, y hacer que cada uno importe este módulo es ruido que
 * termina en un cron nuevo sin lock porque alguien se olvidó del import.
 */
@Global()
@Module({
  providers: [JobLockService],
  exports: [JobLockService],
})
export class JobsModule {}
