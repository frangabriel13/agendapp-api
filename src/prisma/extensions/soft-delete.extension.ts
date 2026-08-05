import { Prisma } from '@prisma/client';

/**
 * Modelos que NO aplican soft delete (no tienen campo `deletedAt`).
 * Mantener esta lista sincronizada con el schema a medida que se agregan tablas.
 *
 * Típicamente: tablas de unión puras, tokens efímeros, logs append-only.
 */
export const SOFT_DELETE_EXEMPT_MODELS = new Set<string>([
  'RefreshToken',
  'AuditLog',
  'Plan', // catálogo global: se da de baja con `isActive`, no con deletedAt
  'Subscription',
  'TenantBranding',
  'TenantSettings',
  'BranchBusinessHour',
  'BranchSpecialDay',
  'EmployeeBranch',
  'EmployeeSchedule',
  'EmployeeService',
  'ServiceResource',
  'CustomerTagAssignment',
  'AppointmentService',
  'AppointmentResource',
  'AppointmentPayment',
  'SubscriptionPayment',
  'RecurrenceGroup',
]);

const FIND_OPS_WITH_FLEXIBLE_WHERE = new Set([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

function modelClientKey(model: string): string {
  return model.charAt(0).toLowerCase() + model.slice(1);
}

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

type PrismaModelDelegate = Record<string, (a: unknown) => Promise<unknown>>;

/**
 * Convierte `delete` / `deleteMany` en `update` / `updateMany` con `deletedAt`,
 * y filtra lecturas para excluir registros con `deletedAt != null`.
 *
 * `findUnique` / `findUniqueOrThrow` no se interceptan: usan `WhereUniqueInput`
 * que típicamente solo expone campos únicos. Para queries que deban respetar
 * soft delete sobre una unique key, usar `findFirst`. RLS (Fase 8) cubre el
 * hueco residual.
 */
export const softDeleteExtension = Prisma.defineExtension((client) =>
  client.$extends({
    name: 'soft-delete',
    query: {
      $allModels: {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        $allOperations: (async (
          params: AnyOperationParams,
        ): Promise<unknown> => {
          const { model, operation, args, query } = params;

          if (!model || SOFT_DELETE_EXEMPT_MODELS.has(model)) {
            return query(args);
          }

          if (operation === 'delete' || operation === 'deleteMany') {
            const targetOp = operation === 'delete' ? 'update' : 'updateMany';
            const modelDelegate = (
              client as unknown as Record<string, PrismaModelDelegate>
            )[modelClientKey(model)];
            const deleteArgs = (args ?? {}) as { where?: unknown };
            return modelDelegate[targetOp]({
              where: deleteArgs.where,
              data: { deletedAt: new Date() },
            });
          }

          if (FIND_OPS_WITH_FLEXIBLE_WHERE.has(operation)) {
            const readArgs = (args ?? {}) as {
              where?: Record<string, unknown>;
            };
            return query({
              ...readArgs,
              where: { deletedAt: null, ...(readArgs.where ?? {}) },
            });
          }

          return query(args);
        }) as any,
      },
    },
  }),
);
