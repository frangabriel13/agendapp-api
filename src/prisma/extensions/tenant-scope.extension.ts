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
  'UserToken', // cuelga de User, que es global: reset de contraseña y verificación
  'Plan',
  'Tenant', // no tiene columna tenantId: ÉL es el tenant. Se filtra por `id`.
  'AuditLog', // tenantId nullable: actions del sistema sin tenant
]);

/**
 * Marca un `data` de create al que le falta el `tenantId` a propósito, porque
 * lo pone la extension en runtime.
 *
 * Sin esto TypeScript rechaza el objeto (`tenantId` es obligatorio en los tipos
 * generados) y la salida fácil sería un `as any`, que apaga el chequeo de TODOS
 * los campos. Esto apaga uno solo:
 *
 * ```ts
 * data: scopedCreate<Prisma.BranchUncheckedCreateInput>({ name: dto.name })
 * ```
 *
 * Pasar el `tenantId` a mano igual no serviría: `applyTenantScope` lo escribe
 * último, así que el del contexto pisa al del caller. Este helper evita el
 * `as any` que haría falta para conformar a TypeScript.
 */
export function scopedCreate<T extends { tenantId: string }>(
  data: Omit<T, 'tenantId'>,
): T {
  return data as T;
}

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
 * Mete el `tenantId` en los args de una operación. Función pura y exportada
 * para poder testearla sin levantar Prisma: es la parte de la extension donde
 * un error se paga caro.
 *
 * **El `tenantId` del contexto va SIEMPRE último en el spread**, así le gana a
 * cualquiera que venga en los args. Al revés, un `where: { tenantId: 'otro' }`
 * escrito por error (o armado con input sin filtrar) pisaría al del contexto y
 * la consulta se escaparía del negocio — justo lo que esta extension existe
 * para impedir. Cuando de verdad hace falta consultar sin filtro, el camino es
 * `runWithoutTenant`, que es explícito y se ve en el código.
 */
export function applyTenantScope(
  operation: string,
  args: unknown,
  tenantId: string,
): unknown {
  if (
    READ_OPS_WITH_FLEXIBLE_WHERE.has(operation) ||
    WRITE_OPS_WITH_WHERE.has(operation)
  ) {
    const opArgs = (args ?? {}) as { where?: Record<string, unknown> };
    return { ...opArgs, where: { ...(opArgs.where ?? {}), tenantId } };
  }

  if (operation === 'create') {
    const createArgs = (args ?? {}) as { data?: Record<string, unknown> };
    return { ...createArgs, data: { ...(createArgs.data ?? {}), tenantId } };
  }

  if (operation === 'createMany') {
    const createManyArgs = (args ?? {}) as {
      data?: Record<string, unknown> | Record<string, unknown>[];
    };
    const data = createManyArgs.data;

    return {
      ...createManyArgs,
      data: Array.isArray(data)
        ? data.map((row) => ({ ...row, tenantId }))
        : { ...(data ?? {}), tenantId },
    };
  }

  // findUnique / findUniqueOrThrow: sin cambios (ver el comentario de abajo).
  return args;
}

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

          return query(
            applyTenantScope(operation, args, store.tenant.tenantId),
          );
        }) as any,
      },
    },
  });
}
