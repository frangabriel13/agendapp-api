/**
 * Las acciones que la auditoría sabe nombrar.
 *
 * La columna es texto libre (ver el modelo `AuditLog`), así que esto **no lo
 * hace cumplir la base**: existe para que una falta de ortografía se vea al
 * compilar y no seis meses después, buscando `"canceled"` en una tabla que
 * tiene guardado `"cancelled"`.
 */
export const AuditAction = {
  LOGIN: 'login',
  LOGIN_FAILED: 'login_failed',
  CREATED: 'created',
  UPDATED: 'updated',
  DELETED: 'deleted',
  ACTIVATED: 'activated',
  PAYMENT_RECORDED: 'payment_recorded',
} as const;

export type AuditAction = (typeof AuditAction)[keyof typeof AuditAction];

/** Sobre qué. Mismo criterio que `AuditAction`: texto en la base, unión acá. */
export const AuditEntity = {
  SESSION: 'session',
  USER: 'user',
  EMPLOYEE: 'employee',
  CUSTOMER: 'customer',
  APPOINTMENT: 'appointment',
  PAYMENT: 'payment',
  TENANT: 'tenant',
} as const;

export type AuditEntity = (typeof AuditEntity)[keyof typeof AuditEntity];

export interface AuditOptions {
  action: AuditAction;
  entityType: AuditEntity;

  /**
   * De dónde sale el id de la entidad.
   *
   * Por defecto: el route param `id` y, si no está, el `id` de la respuesta —
   * que cubre el alta, donde el id recién existe después de escribir.
   *
   * Se pasa a mano cuando la ruta lo llama de otra forma (`:appointmentId`).
   */
  entityIdParam?: string;

  /**
   * Dónde está el id **en la respuesta**, si no es `id` a secas.
   *
   * Es un camino con puntos (`'employee.id'`). Hace falta en las altas que no
   * devuelven la entidad pelada: `POST /employees` contesta
   * `{ employee, activationUrl, emailSent }`, y sin esto la fila de auditoría
   * quedaría sin decir a quién se invitó — que es lo único que se le va a
   * preguntar.
   */
  entityIdFrom?: string;

  /**
   * Registrar también cuando el handler falla.
   *
   * **Apagado por defecto y no es pereza.** El `ValidationPipe` corre dentro
   * del interceptor, así que prenderlo en todos lados llenaría la auditoría de
   * errores de tipeo. Se prende donde el fracaso *es* el evento interesante: un
   * login que no entró.
   */
  alsoOnFailure?: boolean;
}
