import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';

export interface TenantContext {
  tenantId: string;
  userId: string;
  employeeId?: string;
  role?: string;
}

/**
 * Wrapper guardado en el ALS. `tenant` es `null` cuando entramos por
 * `runWithoutTenant` (escape hatch consciente). Si `getStore()` devuelve
 * `undefined`, significa que el caller olvidó montar contexto — eso es
 * un bug que la extension de Prisma va a reportar como error 500.
 */
interface TenantContextStore {
  tenant: TenantContext | null;
}

@Injectable()
export class TenantContextService {
  private readonly als = new AsyncLocalStorage<TenantContextStore>();

  run<T>(ctx: TenantContext, fn: () => T): T {
    return this.als.run({ tenant: ctx }, fn);
  }

  // Escape hatch para flows que legítimamente no tienen tenant en contexto:
  // auth pre-login, seeds, jobs, webhooks de Mercado Pago, healthchecks, etc.
  runWithoutTenant<T>(fn: () => T): T {
    return this.als.run({ tenant: null }, fn);
  }

  /**
   * Devuelve la "intención" del caller:
   * - `{ tenant: ... }`   → request autenticado con tenant.
   * - `{ tenant: null }`  → flow explícito sin tenant (`runWithoutTenant`).
   * - `undefined`         → nunca se montó contexto: probablemente un bug.
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
