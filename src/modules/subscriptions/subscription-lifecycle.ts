import { SubscriptionStatus } from '@prisma/client';

/**
 * Las reglas de la suscripción del negocio a AgendApp, sin base de datos al
 * lado: cuándo vence, cuánto hace que debe, cuándo se le corta el servicio y
 * qué período paga el próximo cobro.
 *
 * Está separado del service por el mismo motivo que `status-machine.ts` en
 * turnos: son decisiones de negocio que conviene poder leer y probar solas.
 * Acá los casos borde valen plata de verdad.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Suma meses a un instante, recortando cuando el día no existe (31 de enero +
 * 1 mes = 28 de febrero).
 *
 * **No es lo mismo que el `addMonths` de `recurrence.ts`** y no hay que
 * unificarlos: aquél trabaja en calendario puro (`"YYYY-MM-DD"`, sin hora) justo
 * para que una serie de turnos que cruza un cambio de horario siga cayendo a la
 * misma hora de pared. Un período de facturación es un instante y no le pasa
 * nada si se corre una hora; mezclarlos reintroduciría el bug que aquél evita.
 */
export function addMonthsUtc(instant: Date, months: number): Date {
  const year = instant.getUTCFullYear();
  const month = instant.getUTCMonth();
  const day = instant.getUTCDate();

  const target = new Date(instant.getTime());
  // Al día 1 primero: sin esto, pasar de un 31 a un mes corto desborda al mes
  // siguiente antes de que lleguemos a recortar.
  target.setUTCFullYear(year, month + months, 1);

  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();

  target.setUTCDate(Math.min(day, lastDay));

  return target;
}

/** Hace cuántos días completos venció el período. `0` si todavía no venció. */
export function daysOverdue(currentPeriodEnd: Date, now: Date): number {
  const elapsed = now.getTime() - currentPeriodEnd.getTime();

  return elapsed <= 0 ? 0 : Math.floor(elapsed / MS_PER_DAY);
}

/** Los estados que el vencimiento puede mover. El resto no se toca. */
const EXPIRABLE_STATUSES: readonly SubscriptionStatus[] = [
  SubscriptionStatus.TRIAL,
  SubscriptionStatus.ACTIVE,
];

/**
 * Si el vencimiento del período tiene que pasarla a `PAST_DUE`.
 *
 * Una prueba que se termina sin pagar cae acá igual que un mes impago: en los
 * dos casos hay un período que venció y nadie pagó el siguiente.
 *
 * `CANCELED` y `PAUSED` no se tocan: el vencimiento no le agrega nada a una
 * suscripción que ya está fuera del ciclo normal.
 */
export function hasLapsed(
  subscription: { status: SubscriptionStatus; currentPeriodEnd: Date },
  now: Date,
): boolean {
  return (
    EXPIRABLE_STATUSES.includes(subscription.status) &&
    subscription.currentPeriodEnd.getTime() <= now.getTime()
  );
}

/**
 * Si hay que cortarle el servicio.
 *
 * **Deber no alcanza: hay que deber hace rato.** El período vence y arranca una
 * ventana de gracia, porque una tarjeta que rebota se arregla en un día y
 * dejar a un negocio sin agenda por eso es desproporcionado. Recién pasada esa
 * ventana se bloquea.
 *
 * Lo que se bloquea es **crear turnos nuevos**, no leer ni cancelar: un negocio
 * que debe tiene que poder seguir viendo su agenda y avisarle a su clientela.
 * Cortarle la lectura convierte un problema de cobranza en un problema para
 * gente que no tiene nada que ver.
 *
 * `PAUSED` no bloquea a propósito: hoy nada la setea, así que definir su
 * comportamiento acá sería inventar una regla sin nadie que la use.
 */
export function blocksNewBookings(
  subscription: { status: SubscriptionStatus; currentPeriodEnd: Date },
  now: Date,
  graceDays: number,
): boolean {
  if (subscription.status === SubscriptionStatus.CANCELED) {
    return true;
  }

  if (subscription.status !== SubscriptionStatus.PAST_DUE) {
    return false;
  }

  return daysOverdue(subscription.currentPeriodEnd, now) > graceDays;
}

/**
 * Qué período cubre el pago que se está por hacer.
 *
 * Si pagó dentro de la ventana de gracia, el período nuevo **arranca donde
 * terminó el anterior**: estuvo usando el servicio esos días y corresponde que
 * los pague. Si volvió mucho después, arranca hoy — cobrarle meses en los que
 * estuvo bloqueado sería cobrarle por nada.
 */
export function nextPeriod(
  previousEnd: Date,
  now: Date,
  graceDays: number,
): { start: Date; end: Date } {
  const start =
    daysOverdue(previousEnd, now) <= graceDays ? previousEnd : new Date(now);

  return { start, end: addMonthsUtc(start, 1) };
}
