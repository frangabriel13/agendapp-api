import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantContext {
  tenantId: string;
  userId: string;
  employeeId?: string;
  role?: string;
}

/**
 * Wrapper guardado en el ALS. `tenant` tiene tres valores posibles y cada uno
 * significa algo distinto para la extension de Prisma:
 * - `TenantContext` → request autenticado: se inyecta el `tenantId` en la query.
 * - `null`          → escape hatch consciente (`runWithoutTenant`): passthrough.
 * - `undefined`     → store montado por el middleware pero todavía sin resolver
 *   (request público o sin auth): la query scopeada falla.
 *
 * Si `getStore()` devuelve `undefined`, el ALS nunca se montó — eso es un bug
 * (falta el middleware) que la extension reporta como error 500.
 */
export interface TenantContextStore {
  tenant?: TenantContext | null;
}

@Injectable()
export class TenantContextService {
  private readonly als = new AsyncLocalStorage<TenantContextStore>();

  /**
   * Corre `fn` con un tenant montado. Para jobs, seeds y tests: en un request
   * HTTP el contexto ya lo montan `TenantContextMiddleware` + `JwtAuthGuard`.
   *
   * ⚠️ **El callback tiene que ser `async` y `await`-ear sus queries.** Las
   * `PrismaPromise` son perezosas: no ejecutan nada hasta que alguien llama a
   * su `.then()`. Si devolvés la promesa sin esperarla, la query arranca
   * *después* de que el contexto se desmontó y falla:
   *
   * ```ts
   * ctx.run(tenant, () => prisma.scoped.branch.findMany());        // ❌ falla
   * ctx.run(tenant, async () => await prisma.scoped.branch.findMany()); // ✅
   * ```
   */
  run<T>(ctx: TenantContext, fn: () => T): T {
    return this.als.run({ tenant: ctx }, fn);
  }

  /**
   * Escape hatch para flows que legítimamente no tienen tenant en contexto:
   * auth pre-login, seeds, jobs, webhooks de Mercado Pago, healthchecks, etc.
   *
   * Aplica la misma advertencia que `run()`: el callback debe `await`-ear sus
   * queries para que corran dentro del contexto.
   */
  runWithoutTenant<T>(fn: () => T): T {
    return this.als.run({ tenant: null }, fn);
  }

  /**
   * Monta un store VACÍO para todo el request. Lo usa `TenantContextMiddleware`:
   * cuando corre el middleware, Nest todavía no ejecutó los guards, así que no
   * hay `request.user` del cual sacar el tenant. El `JwtAuthGuard` lo completa
   * después con `set()`.
   */
  mount<T>(fn: () => T): T {
    return this.als.run({}, fn);
  }

  /**
   * Resuelve el tenant sobre el store ya montado. Muta el objeto del ALS a
   * propósito: así el contexto queda visible en el resto de los guards, en los
   * interceptors y en el handler, sin tener que anidar otro `run()` (que
   * obligaría a envolver la ejecución del handler y no se puede desde un guard).
   */
  set(ctx: TenantContext): void {
    const store = this.als.getStore();

    if (!store) {
      throw new Error(
        'No hay contexto montado en el AsyncLocalStorage: registrá ' +
          'TenantContextMiddleware antes de llamar a set().',
      );
    }

    store.tenant = ctx;
  }

  /**
   * Devuelve la "intención" del caller:
   * - `{ tenant: ... }`       → request autenticado con tenant.
   * - `{ tenant: null }`      → flow explícito sin tenant (`runWithoutTenant`).
   * - `{}` / `{ tenant: undefined }` → montado pero sin resolver (público).
   * - `undefined`             → nunca se montó contexto: probablemente un bug.
   */
  getStore(): TenantContextStore | undefined {
    return this.als.getStore();
  }

  get(): TenantContext | null {
    return this.getStore()?.tenant ?? null;
  }

  getTenantId(): string | null {
    return this.get()?.tenantId ?? null;
  }

  getUserId(): string | null {
    return this.get()?.userId ?? null;
  }

  getEmployeeId(): string | null {
    return this.get()?.employeeId ?? null;
  }
}
