/**
 * Se lanza cuando una query Prisma sobre una tabla con `tenantId` corre sin
 * `TenantContext` en el AsyncLocalStorage. Indica que el código olvidó:
 * - autenticar el request (falta JwtAuthGuard / middleware de contexto), o
 * - envolver un flow interno (seed, job, webhook) en `runWithoutTenant`.
 */
export class TenantContextMissingError extends Error {
  constructor(modelName: string, operation: string) {
    super(
      `Tenant context missing for ${modelName}.${operation}. ` +
        `Wrap internal flows in tenantContext.runWithoutTenant(...) or ensure the request is authenticated.`,
    );
    this.name = 'TenantContextMissingError';
  }
}
