import type { EmployeeRole } from '@prisma/client';

/**
 * Contenido del access token. Se mantiene mínimo y sin datos sensibles:
 * es información firmada, pero legible por cualquiera que tenga el token.
 *
 * `sub` es el `userId` (claim estándar de JWT).
 */
export interface JwtPayload {
  sub: string;
  tenantId: string;
  employeeId: string;
  role: EmployeeRole;
}

/**
 * Lo que el `JwtStrategy` deja en `request.user` una vez validado el token.
 * Ojo: estos valores se releen de la DB en cada request, no se confían del
 * token — así un empleado desactivado o con el rol cambiado deja de tener
 * acceso sin esperar a que expire el access token.
 */
export interface AuthenticatedUser {
  userId: string;
  email: string;
  tenantId: string;
  employeeId: string;
  role: EmployeeRole;
}
