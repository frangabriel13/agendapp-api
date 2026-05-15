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
