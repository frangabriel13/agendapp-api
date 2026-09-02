import { Module } from '@nestjs/common';
import { AppointmentRemindersService } from './appointment-reminders.service';
import { AppointmentsController } from './appointments.controller';
import { AppointmentsCron } from './appointments.cron';
import { AppointmentsService } from './appointments.service';

// Sin imports: PrismaModule, TenantContextModule, MailModule y JobsModule son @Global.
@Module({
  controllers: [AppointmentsController],
  providers: [
    AppointmentsService,
    AppointmentRemindersService,
    AppointmentsCron,
  ],
  exports: [AppointmentsService, AppointmentRemindersService],
})
export class AppointmentsModule {}
