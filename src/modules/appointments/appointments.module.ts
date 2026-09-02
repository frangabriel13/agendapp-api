import { Module } from '@nestjs/common';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsCron } from './appointments.cron';
import { AppointmentsService } from './appointments.service';

// Sin imports: PrismaModule y TenantContextModule son @Global.
@Module({
  controllers: [AppointmentsController],
  providers: [AppointmentsService, AppointmentsCron],
  exports: [AppointmentsService],
})
export class AppointmentsModule {}
