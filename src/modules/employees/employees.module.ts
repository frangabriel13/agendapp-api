import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { EmployeeInvitationService } from './employee-invitations.service';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';

// Importa AuthModule solo por `PasswordService`: el hash de la contraseña que
// elige el empleado al activarse tiene que salir del mismo lugar que el del
// registro. PrismaModule y TenantContextModule son @Global.
@Module({
  imports: [AuthModule],
  controllers: [EmployeesController],
  providers: [EmployeesService, EmployeeInvitationService],
  exports: [EmployeesService],
})
export class EmployeesModule {}
