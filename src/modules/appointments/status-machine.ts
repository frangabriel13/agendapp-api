import { AppointmentStatus, CancellationRefundType } from '@prisma/client';

/**
 * Las reglas de qué puede pasarle a un turno, en un solo lugar.
 *
 * Está separado del service a propósito: son decisiones de negocio puras
 * (¿se puede pasar de acá a allá? ¿corresponde reembolso?) que conviene poder
 * leer y testear sin una base de datos al lado.
 */

/**
 * A qué estados puede pasar cada uno.
 *
 * Los que apuntan a una lista vacía son terminales: un turno atendido no vuelve
 * a estar confirmado, y uno cancelado no se "descancela" — para eso se crea uno
 * nuevo.
 *
 * `RESCHEDULED` no figura como destino de nadie: no se llega ahí con un cambio
 * de estado suelto, sino reprogramando (`POST /appointments/:id/reschedule`),
 * que además crea el turno nuevo y los deja enlazados. Dejarlo disponible acá
 * permitiría marcar un turno como reprogramado sin que exista el reemplazo.
 */
const TRANSITIONS: Readonly<Record<AppointmentStatus, AppointmentStatus[]>> = {
  [AppointmentStatus.PENDING_PAYMENT]: [
    AppointmentStatus.CONFIRMED,
    AppointmentStatus.CANCELED_BY_CUSTOMER,
    AppointmentStatus.CANCELED_BY_BUSINESS,
  ],
  [AppointmentStatus.CONFIRMED]: [
    AppointmentStatus.ATTENDED,
    AppointmentStatus.NO_SHOW,
    AppointmentStatus.CANCELED_BY_CUSTOMER,
    AppointmentStatus.CANCELED_BY_BUSINESS,
  ],
  [AppointmentStatus.ATTENDED]: [],
  [AppointmentStatus.NO_SHOW]: [],
  [AppointmentStatus.CANCELED_BY_CUSTOMER]: [],
  [AppointmentStatus.CANCELED_BY_BUSINESS]: [],
  [AppointmentStatus.RESCHEDULED]: [],
};

export const CANCELED_STATUSES: readonly AppointmentStatus[] = [
  AppointmentStatus.CANCELED_BY_CUSTOMER,
  AppointmentStatus.CANCELED_BY_BUSINESS,
];

/** Un turno terminado: ya no admite cambios de estado ni reprogramación. */
export function isTerminal(status: AppointmentStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export function canTransition(
  from: AppointmentStatus,
  to: AppointmentStatus,
): boolean {
  return TRANSITIONS[from].includes(to);
}

export function allowedTransitions(
  from: AppointmentStatus,
): AppointmentStatus[] {
  return [...TRANSITIONS[from]];
}

export function isCanceled(status: AppointmentStatus): boolean {
  return CANCELED_STATUSES.includes(status);
}

/** Qué le corresponde a quien cancela, según la política del negocio. */
export interface RefundDecision {
  type: CancellationRefundType;
  amountCents: number;
  /** Si canceló con la antelación que pide el negocio. */
  withinPolicy: boolean;
  /** Explicación lista para mostrar. */
  reason: string;
}

export interface CancellationPolicy {
  cancellationPolicyHours: number;
  cancellationRefundType: CancellationRefundType;
  cancellationRefundPercentage: number | null;
}

/**
 * Cuánto se devuelve al cancelar.
 *
 * La regla es una sola: si canceló con al menos `cancellationPolicyHours` de
 * anticipación, se aplica la política del negocio; si llegó tarde, no se
 * devuelve nada. Lo que se calcula es sobre **la seña**, que es lo único que
 * pudo haberse cobrado antes del turno.
 *
 * **Esto no mueve plata**, solo dice qué corresponde: la devolución real es de
 * la Fase 6, cuando exista Mercado Pago. Se calcula igual y viaja en la
 * respuesta para que el mostrador pueda decirle algo concreto a la clienta en
 * el momento, y para que el día que se conecte el pago no haya que reconstruir
 * la decisión de una cancelación vieja.
 */
export function resolveRefund(
  policy: CancellationPolicy,
  appointment: {
    startsAt: Date;
    depositAmountCents: number | null;
    depositPaid: boolean;
  },
  canceledAt: Date,
): RefundDecision {
  const hoursAhead =
    (appointment.startsAt.getTime() - canceledAt.getTime()) / 3_600_000;
  const withinPolicy = hoursAhead >= policy.cancellationPolicyHours;

  const paid =
    appointment.depositPaid && appointment.depositAmountCents !== null
      ? appointment.depositAmountCents
      : 0;

  if (paid === 0) {
    return {
      type: CancellationRefundType.NONE,
      amountCents: 0,
      withinPolicy,
      reason: 'No había seña pagada, así que no hay nada que devolver',
    };
  }

  if (!withinPolicy) {
    return {
      type: CancellationRefundType.NONE,
      amountCents: 0,
      withinPolicy,
      reason:
        `La cancelación entró con menos de ${policy.cancellationPolicyHours} ` +
        'horas de anticipación: según la política del negocio, la seña no se devuelve',
    };
  }

  switch (policy.cancellationRefundType) {
    case CancellationRefundType.FULL:
      return {
        type: CancellationRefundType.FULL,
        amountCents: paid,
        withinPolicy,
        reason: 'Canceló en término: corresponde devolver la seña completa',
      };

    case CancellationRefundType.PARTIAL: {
      // El CHECK de la Fase 1 obliga a que el porcentaje esté cargado cuando el
      // tipo es `partial`, así que el `?? 0` es defensivo, no un caso real.
      const percentage = policy.cancellationRefundPercentage ?? 0;

      return {
        type: CancellationRefundType.PARTIAL,
        amountCents: Math.round((paid * percentage) / 100),
        withinPolicy,
        reason: `Canceló en término: corresponde devolver el ${percentage}% de la seña`,
      };
    }

    case CancellationRefundType.CREDIT:
      return {
        type: CancellationRefundType.CREDIT,
        amountCents: paid,
        withinPolicy,
        reason:
          'Canceló en término: la seña queda como crédito a favor para un ' +
          'próximo turno',
      };

    case CancellationRefundType.NONE:
      return {
        type: CancellationRefundType.NONE,
        amountCents: 0,
        withinPolicy,
        reason: 'La política del negocio no contempla devolución de la seña',
      };
  }
}
