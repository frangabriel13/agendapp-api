import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobLockService } from '../../common/jobs';
import { AppointmentRemindersService } from './appointment-reminders.service';
import { AppointmentsService } from './appointments.service';

/**
 * El reloj de los turnos. Como en suscripciones, la lógica vive en los services
 * y esto solo decide cuándo llamarlos: así cada job se puede probar (y forzar a
 * mano) sin esperar al próximo tick.
 *
 * **El lock entre réplicas se toma acá y no adentro de los services**, con una
 * excepción explicada abajo. `@nestjs/schedule` no coordina instancias: con
 * tres procesos, cada `@Cron` dispara tres veces. Ponerlo en el cron y no en el
 * service mantiene honesto el tipo de retorno —`releaseAbandoned` devuelve
 * cuántos soltó, no "cuántos soltó o `null` si otro lo estaba haciendo"— y deja
 * que una llamada directa (un test, un script) corra sin pedir permiso, que es
 * lo que uno quiere de una llamada directa.
 */
@Injectable()
export class AppointmentsCron {
  private readonly logger = new Logger(AppointmentsCron.name);

  constructor(
    private readonly appointments: AppointmentsService,
    private readonly reminders: AppointmentRemindersService,
    private readonly jobLock: JobLockService,
  ) {}

  /**
   * Cada diez minutos, y no de madrugada como el vencimiento de suscripciones.
   * La diferencia no es un capricho: acá lo que se libera es un hueco de hoy.
   * Un barrido diario dejaría la agenda tapada justo el día en que la reserva
   * se abandonó, que es exactamente cuando se necesitaba libre.
   */
  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'release-abandoned-bookings' })
  async releaseAbandoned(): Promise<void> {
    await this.guard('release-abandoned-bookings', async () => {
      const count = await this.appointments.releaseAbandoned();

      if (count > 0) {
        this.logger.log({ count }, 'Reservas públicas sin pagar liberadas');
      }
    });
  }

  /**
   * Cada quince minutos.
   *
   * El número no sale de la precisión que quiere el recordatorio sino de la que
   * tolera: las ventanas son de horas, así que un cuarto de hora de retraso no
   * se nota. Más seguido serían más barridos para encontrar lo mismo.
   *
   * ⚠️ **Este no se envuelve en `guard`.** `sendDue` toma el lock por su
   * cuenta, y solo alrededor de la parte que consulta: los mails salen afuera,
   * porque sostener una transacción de Postgres mientras se espera a un
   * proveedor HTTP es justo lo que no hay que hacer.
   */
  // Expresión cruda y no `CronExpression`: no hay constante de 15 minutos, y
  // poner 10 o 30 solo para usar una sería dejar que la librería elija el
  // número por nosotros.
  @Cron('0 */15 * * * *', { name: 'appointment-reminders' })
  async sendReminders(): Promise<void> {
    try {
      const sent = await this.reminders.sendDue();

      if (sent > 0) {
        this.logger.log({ sent }, 'Recordatorios de turno enviados');
      }
    } catch (error) {
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'Falló el envío de recordatorios',
      );
    }
  }

  /**
   * Corre el job con el lock tomado y sin dejar escapar nada.
   *
   * Lo segundo no es decoración: una excepción en el callback de un timer no
   * tiene quién la agarre más arriba y **tumba el proceso**.
   */
  private async guard(name: string, work: () => Promise<void>): Promise<void> {
    try {
      await this.jobLock.run(name, work);
    } catch (error) {
      this.logger.error(
        {
          job: name,
          err: error instanceof Error ? error.message : String(error),
        },
        'Falló un job de turnos',
      );
    }
  }
}
