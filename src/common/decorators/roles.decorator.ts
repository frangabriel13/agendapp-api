import { SetMetadata, type CustomDecorator } from '@nestjs/common';
import type { EmployeeRole } from '@prisma/client';

export const ROLES_KEY = 'roles';

/**
 * Restringe un handler (o un controller entero) a ciertos roles de empleado.
 *
 * Sin este decorator, cualquier empleado autenticado del tenant puede entrar:
 * el `JwtAuthGuard` responde "quién sos", esto responde "qué podés hacer".
 *
 * El rol se lee del `request.user`, que `JwtStrategy` rearma desde la base en
 * cada request — así, si al empleado le cambian el rol, deja de tener permiso
 * en el acto y no cuando venza el token.
 */
export const Roles = (...roles: EmployeeRole[]): CustomDecorator<string> =>
  SetMetadata(ROLES_KEY, roles);
