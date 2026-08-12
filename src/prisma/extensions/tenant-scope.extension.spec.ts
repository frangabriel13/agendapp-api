import { applyTenantScope } from './tenant-scope.extension';

const TENANT = 'tenant-propio';
const AJENO = 'tenant-ajeno';

describe('applyTenantScope', () => {
  describe('lecturas y escrituras con where', () => {
    it.each([
      'findFirst',
      'findFirstOrThrow',
      'findMany',
      'count',
      'aggregate',
      'groupBy',
      'update',
      'updateMany',
      'delete',
      'deleteMany',
      'upsert',
    ])('inyecta el tenantId en %s', (operation) => {
      const scoped = applyTenantScope(
        operation,
        { where: { id: 'x' } },
        TENANT,
      );

      expect(scoped).toEqual({ where: { id: 'x', tenantId: TENANT } });
    });

    it('funciona sin where y sin args', () => {
      expect(applyTenantScope('findMany', {}, TENANT)).toEqual({
        where: { tenantId: TENANT },
      });
      expect(applyTenantScope('findMany', undefined, TENANT)).toEqual({
        where: { tenantId: TENANT },
      });
    });

    it('respeta el resto de los args', () => {
      const scoped = applyTenantScope(
        'findMany',
        { select: { id: true }, orderBy: { name: 'asc' }, take: 10 },
        TENANT,
      );

      expect(scoped).toMatchObject({
        select: { id: true },
        orderBy: { name: 'asc' },
        take: 10,
        where: { tenantId: TENANT },
      });
    });
  });

  describe('creates', () => {
    it('inyecta el tenantId en create', () => {
      const scoped = applyTenantScope(
        'create',
        { data: { name: 'x' } },
        TENANT,
      );

      expect(scoped).toEqual({ data: { name: 'x', tenantId: TENANT } });
    });

    it('inyecta el tenantId en cada fila de un createMany', () => {
      const scoped = applyTenantScope(
        'createMany',
        { data: [{ name: 'a' }, { name: 'b' }] },
        TENANT,
      );

      expect(scoped).toEqual({
        data: [
          { name: 'a', tenantId: TENANT },
          { name: 'b', tenantId: TENANT },
        ],
      });
    });

    it('acepta un createMany con una sola fila (sin array)', () => {
      const scoped = applyTenantScope(
        'createMany',
        { data: { name: 'a' } },
        TENANT,
      );

      expect(scoped).toEqual({ data: { name: 'a', tenantId: TENANT } });
    });
  });

  /**
   * El corazón de la extension: si el tenantId del caller pudiera ganarle al
   * del contexto, la red de seguridad tendría un agujero en su propia red.
   * Para consultar de verdad sin filtro está `runWithoutTenant`, que es
   * explícito y se ve leyendo el código.
   */
  describe('el contexto siempre le gana al caller', () => {
    it('pisa un tenantId ajeno en el where', () => {
      const scoped = applyTenantScope(
        'findMany',
        { where: { tenantId: AJENO } },
        TENANT,
      );

      expect(scoped).toEqual({ where: { tenantId: TENANT } });
    });

    it('pisa un tenantId ajeno en el data de un create', () => {
      const scoped = applyTenantScope(
        'create',
        { data: { name: 'x', tenantId: AJENO } },
        TENANT,
      );

      expect(scoped).toEqual({ data: { name: 'x', tenantId: TENANT } });
    });

    it('pisa un tenantId ajeno en cada fila de un createMany', () => {
      const scoped = applyTenantScope(
        'createMany',
        { data: [{ name: 'a', tenantId: AJENO }, { name: 'b' }] },
        TENANT,
      );

      expect(scoped).toEqual({
        data: [
          { name: 'a', tenantId: TENANT },
          { name: 'b', tenantId: TENANT },
        ],
      });
    });

    it('pisa un tenantId ajeno en un update', () => {
      const scoped = applyTenantScope(
        'update',
        { where: { id: 'x', tenantId: AJENO }, data: { name: 'y' } },
        TENANT,
      );

      expect(scoped).toEqual({
        where: { id: 'x', tenantId: TENANT },
        data: { name: 'y' },
      });
    });
  });

  /**
   * `WhereUniqueInput` normalmente solo acepta campos únicos, así que no se
   * puede inyectar nada. Para respetar el tenant sobre una unique key hay que
   * usar `findFirst`; la RLS de la Fase 8 es la red final.
   */
  describe('findUnique', () => {
    it.each(['findUnique', 'findUniqueOrThrow'])(
      'deja %s tal cual',
      (operation) => {
        const args = { where: { id: 'x' } };

        expect(applyTenantScope(operation, args, TENANT)).toBe(args);
      },
    );
  });

  it('no muta los args que recibe', () => {
    const args = { where: { id: 'x' } };

    applyTenantScope('findMany', args, TENANT);

    expect(args).toEqual({ where: { id: 'x' } });
  });
});
