import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { TenantContextService } from './tenant-context.service';

/**
 * Monta el AsyncLocalStorage al principio de CADA request.
 *
 * Por qué un middleware y no un guard/interceptor: el middleware es lo primero
 * que corre en el ciclo de vida de Nest, y como llama a `next()` dentro de
 * `als.run(...)`, todo lo que viene después (guards, interceptors, pipes,
 * handler, filtros) queda dentro del mismo contexto asincrónico.
 *
 * El store arranca VACÍO a propósito: acá todavía no pasó el `JwtAuthGuard`, así
 * que no hay `request.user`. El guard lo completa con `tenantContext.set(...)`
 * mutando este mismo objeto. Mientras no se resuelva, cualquier query sobre
 * `prisma.scoped` falla con `TenantContextMissingError` — que es exactamente lo
 * que queremos en un endpoint público que se olvidó de resolver su tenant.
 */
@Injectable()
export class TenantContextMiddleware implements NestMiddleware {
  constructor(private readonly tenantContext: TenantContextService) {}

  use(_req: Request, _res: Response, next: NextFunction): void {
    this.tenantContext.mount(() => {
      next();
    });
  }
}
