import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SubscriptionsService } from './subscriptions.service';

/**
 * El reloj de las suscripciones. Toda la lógica vive en el service; esto solo
 * decide cuándo llamarla.
 *
 * Separado a propósito: así el vencimiento se puede probar (y forzar a mano)
 * sin esperar a que den las 3 de la mañana.
 *
 * ⚠️ **Corre en cada instancia de la app.** `@nestjs/schedule` no coordina
 * réplicas, así que con dos procesos esto se ejecuta dos veces. No es un
 * problema porque `expireLapsed` es idempotente —la segunda corrida no
 * encuentra nada que vencer— pero es la razón por la que cualquier job que se
 * agregue acá tiene que serlo también, hasta que exista el lock de la cola
 * (Fase 8).
 */
@Injectable()
export class SubscriptionsCron {
  private readonly logger = new Logger(SubscriptionsCron.name);

  constructor(private readonly subscriptions: SubscriptionsService) {}

  /**
   * De madrugada, cuando no hay nadie usando la agenda: un negocio que se
   * entera de que venció justo mientras carga un turno tiene una experiencia
   * bastante peor que uno que lo ve al abrir a la mañana.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'expire-subscriptions' })
  async expireLapsed(): Promise<void> {
    try {
      const count = await this.subscriptions.expireLapsed();

      if (count > 0) {
        this.logger.log({ count }, 'Suscripciones vencidas');
      }
    } catch (error) {
      // Un job que lanza tumba el proceso: una excepción en un callback de
      // timer no tiene quién la agarre más arriba.
      this.logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'Falló el vencimiento de suscripciones',
      );
    }
  }
}
