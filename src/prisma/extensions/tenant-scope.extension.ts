import { Prisma } from '@prisma/client';
import { TenantContextMissingError } from '../../common/errors/tenant-context-missing.error';
import type { TenantContextService } from '../../common/tenant-context';

/**
 * Modelos que NO llevan `tenantId` (catálogos globales, auth, logs cross-tenant).
 * Mantener sincronizada con el schema. Cualquier modelo de negocio nuevo
 * AUTOMÁTICAMENTE entra al scoping — para excluirlo hay que sumarlo acá
 * explícitamente y justificarlo en el PR.
 */
export const TENANT_EXEMPT_MODELS = new Set<string>([
  'User',
  'RefreshToken',
  'Plan',
  'Tenant', // no tiene columna tenantId: ÉL es el tenant. Se filtra por `id`.
  'AuditLog', // tenantId nullable: actions del sistema sin tenant
]);

const READ_OPS_WITH_FLEXIBLE_WHERE = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

const WRITE_OPS_WITH_WHERE = new Set([
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'upsert',
]);

/**
 * Hook genérico — los args/query vienen tipados como `never` mientras el schema
 * esté vacío (Fase 0). En Fase 1, cuando aparezcan modelos, conviene revisitar
 * los casts y reemplazarlos por los tipos generados de Prisma.
 */
type AnyOperationParams = {
  model: string;
  operation: string;
  args: unknown;
  query: (args: unknown) => Promise<unknown>;
};

/**
 * Inyecta `tenantId` en todas las queries Prisma sobre modelos de negocio.
 *
 * Comportamiento ESTRICTO:
 * - Si el caller NO montó contexto (`getStore() === undefined`) sobre un modelo
 *   no exento, lanza `TenantContextMissingError` (capturado por el filtro global
 *   como 500). Esto hace evidente un bug de falta de auth o middleware.
 * - Si el store está montado pero el tenant sigue SIN RESOLVER (`tenant`
 *   undefined: request público, o autenticado que nunca pasó por el guard),
 *   también lanza. Nunca se degrada a "consulta sin filtro".
 * - Si el caller entró por `runWithoutTenant` (store con `tenant: null`),
 *   passthrough: la query corre sin filtro por tenant. Es el escape hatch
 *   explícito para auth pre-login, seeds, jobs y webhooks.
 *
 * `findUnique` / `findUniqueOrThrow` se passthrough porque su `WhereUniqueInput`
 * típicamente sólo acepta unique fields. Para queries que necesiten respetar
 * tenant sobre una unique key, usar `findFirst`. RLS (Fase 8) es la red final.
 */
export function tenantScopeExtension(ctx: TenantContextService) {
  return Prisma.defineExtension({
    name: 'tenant-scope',
    query: {
      $allModels: {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        $allOperations: (async (
          params: AnyOperationParams,
        ): Promise<unknown> => {
          const { model, operation, args, query } = params;

          if (!model || TENANT_EXEMPT_MODELS.has(model)) {
            return query(args);
          }

          const store = ctx.getStore();

          // `undefined` en cualquiera de los dos niveles = contexto no resuelto:
          // o nunca se montó el ALS, o el request no llegó a autenticarse.
          if (store === undefined || store.tenant === undefined) {
            throw new TenantContextMissingError(model, operation);
          }

          // Escape hatch: runWithoutTenant — passthrough sin filtro.
          if (store.tenant === null) {
            return query(args);
          }

          const tenantId = store.tenant.tenantId;

          if (
            READ_OPS_WITH_FLEXIBLE_WHERE.has(operation) ||
            WRITE_OPS_WITH_WHERE.has(operation)
          ) {
            const opArgs = (args ?? {}) as { where?: Record<string, unknown> };
            return query({
              ...opArgs,
              where: { tenantId, ...(opArgs.where ?? {}) },
            });
          }

          if (operation === 'create') {
            const createArgs = (args ?? {}) as {
              data?: Record<string, unknown>;
            };
            return query({
              ...createArgs,
              data: { tenantId, ...(createArgs.data ?? {}) },
            });
          }

          if (operation === 'createMany') {
            const createManyArgs = (args ?? {}) as {
              data?: Record<string, unknown> | Record<string, unknown>[];
            };
            const data = createManyArgs.data;
            const enrichedData = Array.isArray(data)
              ? data.map((row) => ({ tenantId, ...row }))
              : { tenantId, ...(data ?? {}) };
            return query({
              ...createManyArgs,
              data: enrichedData,
            });
          }

          // findUnique / findUniqueOrThrow: passthrough (ver comentario arriba).
          return query(args);
        }) as any,
      },
    },
  });
}
