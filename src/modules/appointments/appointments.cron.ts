import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AppointmentsService } from './appointments.service';

/**
 * El reloj de los turnos. Como en suscripciones, la lógica vive en el service y
 * esto solo decide cuándo llamarla: así la limpieza se puede probar y forzar a
 * mano sin esperar al próximo tick.
 *
 * ⚠️ **Corre en cada instancia de la app.** `@nestjs/schedule` no coordina
 * réplicas. `releaseAbandoned` es idempotente —la segunda corrida no encuentra
 * nada que soltar— que es la condición para que eso no sea un problema.
 */
@Injectable()
export class AppointmentsCron {
  private readonly logger = new Logger(AppointmentsCron.name);

  constructor(private readonly appointments: AppointmentsService) {}

  /**
   * Cada diez minutos, y no de madrugada como el vencimiento de suscripciones.
   * La diferencia no es un capricho: acá lo que se libera es un hueco de hoy.
   * Un barrido diario dejaría la agenda tapada justo el día en que la reserva
   * se abandonó, que es exactamente cuando se necesitaba libre.
   */
  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'release-abandoned-bookings' })
  async releaseAbandoned(): Promise<void> {
    try {
      const count = await this.appointments.releaseAbandoned();

      if (count > 0) {
        this.logger.log({ count }, 'Reservas públicas sin pagar liberadas');
      }
    } catch (error) {
      // Un job que lanza tumba el proceso: una excepción en un callback de
      // timer no tiene quién la agarre más arriba.
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'Falló la liberación de reservas abandonadas',
      );
    }
  }
}
