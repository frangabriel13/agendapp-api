import type { NextFunction, Request, Response } from 'express';
import { TenantContextMiddleware } from './tenant-context.middleware';
import { TenantContextService } from './tenant-context.service';

describe('TenantContextMiddleware', () => {
  let service: TenantContextService;
  let middleware: TenantContextMiddleware;

  const request = {} as Request;
  const response = {} as Response;

  beforeEach(() => {
    service = new TenantContextService();
    middleware = new TenantContextMiddleware(service);
  });

  const run = (next: NextFunction): void =>
    middleware.use(request, response, next);

  it('monta el store antes de seguir la cadena', () => {
    expect(service.getStore()).toBeUndefined();

    let storeDuringNext: unknown;
    run(() => {
      storeDuringNext = service.getStore();
    });

    expect(storeDuringNext).toEqual({});
  });

  it('deja el tenant sin resolver: el scoping tiene que fallar hasta el guard', () => {
    let tenant: unknown = 'sin-tocar';
    run(() => {
      tenant = service.getStore()?.tenant;
    });

    expect(tenant).toBeUndefined();
  });

  it('permite que un guard posterior resuelva el tenant sobre el mismo store', () => {
    let tenantId: string | null = null;

    run(() => {
      // Esto es lo que hace JwtAuthGuard después de validar el token.
      service.set({ tenantId: 't1', userId: 'u1', employeeId: 'e1' });
      tenantId = service.getTenantId();
    });

    expect(tenantId).toBe('t1');
  });

  it('mantiene el contexto a través de operaciones asincrónicas', async () => {
    const seen = await new Promise<string | null>((resolve) => {
      run(() => {
        service.set({ tenantId: 't-async', userId: 'u1' });
        setTimeout(() => resolve(service.getTenantId()), 0);
      });
    });

    expect(seen).toBe('t-async');
  });

  it('no filtra el contexto entre requests concurrentes', async () => {
    const handle = (tenantId: string): Promise<string | null> =>
      new Promise((resolve) => {
        run(() => {
          service.set({ tenantId, userId: 'u1' });
          setTimeout(() => resolve(service.getTenantId()), 0);
        });
      });

    await expect(Promise.all([handle('t1'), handle('t2')])).resolves.toEqual([
      't1',
      't2',
    ]);
    expect(service.getTenantId()).toBeNull();
  });
});
