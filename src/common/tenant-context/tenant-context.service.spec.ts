import { TenantContextService } from './tenant-context.service';

describe('TenantContextService', () => {
  let service: TenantContextService;

  beforeEach(() => {
    service = new TenantContextService();
  });

  it('devuelve null para tenantId fuera de un run', () => {
    expect(service.getStore()).toBeUndefined();
    expect(service.getTenantId()).toBeNull();
    expect(service.getUserId()).toBeNull();
  });

  it('expone el contexto dentro de run()', () => {
    const result = service.run(
      { tenantId: 't1', userId: 'u1', employeeId: 'e1', role: 'owner' },
      () => ({
        tenantId: service.getTenantId(),
        userId: service.getUserId(),
        employeeId: service.getEmployeeId(),
      }),
    );
    expect(result).toEqual({ tenantId: 't1', userId: 'u1', employeeId: 'e1' });
  });

  it('runWithoutTenant deja un store explícito con tenant = null', () => {
    const store = service.runWithoutTenant(() => service.getStore());
    expect(store).toEqual({ tenant: null });
  });

  it('distingue "sin contexto" (undefined) de runWithoutTenant (tenant: null)', () => {
    expect(service.getStore()).toBeUndefined();
    const inside = service.runWithoutTenant(() => service.getStore());
    expect(inside).toBeDefined();
    expect(inside?.tenant).toBeNull();
  });

  it('mount() deja el store montado pero sin resolver', () => {
    const store = service.mount(() => service.getStore());
    expect(store).toEqual({});
    expect(store?.tenant).toBeUndefined();
  });

  it('set() resuelve el tenant sobre el store montado', () => {
    const inside = service.mount(() => {
      service.set({ tenantId: 't1', userId: 'u1', employeeId: 'e1' });
      return {
        tenantId: service.getTenantId(),
        userId: service.getUserId(),
        employeeId: service.getEmployeeId(),
      };
    });

    expect(inside).toEqual({ tenantId: 't1', userId: 'u1', employeeId: 'e1' });
    // El contexto no sobrevive fuera del mount.
    expect(service.getTenantId()).toBeNull();
  });

  it('set() falla si nadie montó el contexto (falta el middleware)', () => {
    expect(() => service.set({ tenantId: 't1', userId: 'u1' })).toThrow(
      /TenantContextMiddleware/,
    );
  });

  it('distingue "montado sin resolver" de runWithoutTenant', () => {
    expect(service.mount(() => service.getStore())?.tenant).toBeUndefined();
    expect(
      service.runWithoutTenant(() => service.getStore())?.tenant,
    ).toBeNull();
  });

  it('aísla contextos en runs anidados con AsyncLocalStorage', () => {
    const outer = service.run({ tenantId: 'outer', userId: 'u' }, () => {
      const innerTenant = service.run({ tenantId: 'inner', userId: 'u' }, () =>
        service.getTenantId(),
      );
      return {
        outerBefore: service.getTenantId(),
        innerTenant,
        outerAfter: service.getTenantId(),
      };
    });
    expect(outer).toEqual({
      outerBefore: 'outer',
      innerTenant: 'inner',
      outerAfter: 'outer',
    });
  });
});
