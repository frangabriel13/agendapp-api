/**
 * Detección de violaciones de EXCLUDE constraint.
 *
 * Prisma no conoce este tipo de constraint —no lo puede declarar en el schema—,
 * así que **tampoco lo traduce**. Un `UNIQUE` roto llega como un
 * `PrismaClientKnownRequestError` con código `P2002`, pero un EXCLUDE roto llega
 * como un `DriverAdapterError` crudo del driver de Postgres. Sin esto, el
 * doble-booking que la Fase 5 se encarga de hacer imposible saldría como un 500
 * en vez de como un 409 con un mensaje que se entienda.
 *
 * La forma del error (verificada contra `@prisma/adapter-pg`):
 *
 * ```
 * DriverAdapterError { cause: { code: '23P01', message: 'conflicting key value
 *   violates exclusion constraint "appointments_no_employee_overlap"', ... } }
 * ```
 *
 * `23P01` es `exclusion_violation` en el catálogo de errores de Postgres.
 */

const EXCLUSION_VIOLATION = '23P01';

const CONSTRAINT_NAME = /exclusion constraint "([^"]+)"/;

/** El nombre del constraint que se violó, o `null` si el error es otra cosa. */
export function exclusionViolationConstraint(error: unknown): string | null {
  if (!(error instanceof Error) || !('cause' in error)) {
    return null;
  }

  const cause = error.cause as { code?: unknown; message?: unknown } | null;

  if (!cause || cause.code !== EXCLUSION_VIOLATION) {
    return null;
  }

  const message = typeof cause.message === 'string' ? cause.message : '';

  return CONSTRAINT_NAME.exec(message)?.[1] ?? '';
}

/** `true` si el error es cualquier violación de EXCLUDE. */
export function isExclusionViolation(error: unknown): boolean {
  return exclusionViolationConstraint(error) !== null;
}
