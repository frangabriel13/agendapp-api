import { Module } from '@nestjs/common';
import { AuditLogsController } from './audit-logs.controller';
import { AuditLogsService } from './audit-logs.service';
import { AuditService } from './audit.service';

/**
 * La auditoría: quién hizo qué.
 *
 * Es infraestructura transversal, como los mails, pero **no es `@Global`**: lo
 * único que necesita `AuditService` es el interceptor, y el interceptor se
 * registra una sola vez en `AppModule`. Hacerlo global invitaría a que los
 * services lo inyecten y escriban filas por su cuenta, que es justo lo que
 * hace que una auditoría deje de ser comparable consigo misma.
 */
@Module({
  controllers: [AuditLogsController],
  providers: [AuditService, AuditLogsService],
  exports: [AuditService],
})
export class AuditModule {}
