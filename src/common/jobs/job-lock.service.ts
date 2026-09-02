import { Injectable, Logger } from '@nestjs/common';
import { TenantContextService } from '../tenant-context';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Cuánto puede durar un job con el lock tomado, en milisegundos.
 *
 * Es el `timeout` de la transacción que sostiene el lock. Los tres jobs de hoy
 * hacen consultas y nada más, así que sobra; existe para que un job colgado
 * suelte el lock en vez de dejar a las demás instancias sin correr para
 * siempre.
 */
const LOCK_TIMEOUT_MS = 30_000;

/** Cuánto espera Prisma a que el pool le dé una conexión para la transacción. */
const LOCK_MAX_WAIT_MS = 5_000;

/**
 * Que un job corra en una sola instancia a la vez.
 *
 * `@nestjs/schedule` no coordina réplicas: con tres procesos, cada `@Cron`
 * dispara tres veces. Mientras los jobs fueron idempotentes eso se toleraba,
 * pero "idempotente" no es lo mismo que "correcto": con recordatorios, tres
 * corridas simultáneas son tres mails a la misma persona.
 *
 * **Advisory lock de Postgres, no Redis.** Es el mismo servicio que ya está
 * ahí, no hay dependencia nueva, y —lo que más importa— **se libera solo si el
 * proceso se muere**: no queda un lock huérfano bloqueando el cron hasta que
 * alguien lo note.
 *
 * ⚠️ **Es `pg_try_advisory_xact_lock` y no `pg_try_advisory_lock`, y eso no es
 * un detalle.** El de sesión hay que soltarlo a mano, y con un pool de
 * conexiones el `unlock` puede salir por una conexión distinta de la que
 * tomó el lock — el resultado sería un lock que nunca se libera. El de
 * transacción lo suelta Postgres al terminar la transacción, siempre.
 *
 * La consecuencia de esa elección: **el trabajo corre mientras la transacción
 * sigue abierta**, sosteniendo una conexión del pool. Está bien para lo que hay
 * hoy (jobs que solo consultan) y es la razón por la que el job de
 * recordatorios manda los mails **afuera**: no se sostiene una transacción
 * mientras se espera a un proveedor de mail.
 */
@Injectable()
export class JobLockService {
  private readonly logger = new Logger(JobLockService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Corre `work` si consigue el lock; si no, devuelve `null` sin esperar.
   *
   * No esperar es a propósito: si otra instancia ya está haciendo este trabajo,
   * hacerlo de nuevo dos segundos después no aporta nada. El próximo tick lo
   * vuelve a intentar.
   */
  async run<T>(name: string, work: () => Promise<T>): Promise<T | null> {
    const key = lockKey(name);

    return this.tenantContext.runWithoutTenant(async () =>
      this.prisma.$transaction(
        async (tx) => {
          const [row] = await tx.$queryRaw<{ locked: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(CAST(${key} AS bigint)) AS locked
          `;

          if (row?.locked !== true) {
            this.logger.debug(
              { job: name },
              'Otra instancia lo está corriendo',
            );

            return null;
          }

          return await work();
        },
        { timeout: LOCK_TIMEOUT_MS, maxWait: LOCK_MAX_WAIT_MS },
      ),
    );
  }
}

/**
 * El nombre del job como número, que es lo único que entiende Postgres.
 *
 * FNV-1a de 32 bits: determinista entre procesos y versiones —dos instancias
 * tienen que llegar al mismo número o el lock no sirve para nada— y sin
 * dependencias. Una colisión entre dos nombres solo haría que esos dos jobs no
 * corran a la vez, que es molesto y no incorrecto.
 */
export function lockKey(name: string): number {
  let hash = 0x811c9dc5;

  for (let i = 0; i < name.length; i += 1) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }

  // `>>> 0` lo deja sin signo: un negativo también funcionaría como clave, pero
  // un número que cambia de signo según el nombre es más difícil de reconocer
  // en `pg_locks` cuando hay que ir a mirar por qué un job no corre.
  return hash >>> 0;
}
