import { TenantContextService } from '../src/common/tenant-context';
import type { PrismaService } from '../src/prisma/prisma.service';
import {
  createTestApp,
  registerTenant,
  resetDatabase,
  type RegisteredTenant,
  type TestApp,
} from './utils/e2e-app';

/**
 * El aislamiento que **no** depende de que el código esté bien.
 *
 * Todo este archivo usa `prisma` **a secas** —el cliente base, sin la extension
 * de tenant-scope— así que ninguna de estas consultas lleva filtro por negocio.
 * Es, literalmente, el bug que la extension existe para prevenir: si alguna
 * devuelve algo del vecino, RLS no está haciendo nada.
 *
 * ⚠️ Esto solo prueba algo porque la app de los e2e corre con un rol
 * **restringido** (`agendapp_e2e`, ver `test/setup-env.ts`). Un superusuario
 * ignora RLS con `FORCE` y todo, y este archivo pasaría entero sin que ninguna
 * política cortara nada.
 */
describe('RLS: el aislamiento que no depende del código (e2e)', () => {
  let app: TestApp;
  let prisma: PrismaService;
  let tenantContext: TenantContextService;
  let unNegocio: RegisteredTenant;
  let elOtro: RegisteredTenant;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
    tenantContext = app.get(TenantContextService);
  });

  afterAll(async () => {
    await app.close();
  });

  /**
   * Corre `fn` como si fuera un request de ese negocio, con el mismo mecanismo
   * que usa la app.
   *
   * ⚠️ El `async`/`await` de adentro no es adorno. Las `PrismaPromise` son
   * **perezosas**: devolviendo la promesa sin esperarla, la consulta sale
   * cuando el `await` de afuera la despierta —ya fuera del contexto— y el pool
   * no encuentra ningún negocio que mandarle a Postgres. Es la misma trampa que
   * `CLAUDE.md` documenta para `runWithoutTenant`, y acá el síntoma sería el
   * peor posible: **los tests pasarían**, porque sin negocio resuelto la
   * política deja ver todo.
   */
  function como<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
    return tenantContext.run({ tenantId }, async () => await fn());
  }

  beforeEach(async () => {
    await resetDatabase(prisma);
    unNegocio = await registerTenant(app, 'Peluquería Ana');
    elOtro = await registerTenant(app, 'Peluquería Beto');
  });

  // ── La prueba de fuego ────────────────────────────────────────────────────

  it('una consulta SIN filtro de tenant no ve al vecino', async () => {
    const empleados = await como(unNegocio.tenantId, () =>
      prisma.employee.findMany({ select: { tenantId: true } }),
    );

    expect(empleados.length).toBeGreaterThan(0);
    expect(new Set(empleados.map((row) => row.tenantId))).toEqual(
      new Set([unNegocio.tenantId]),
    );
  });

  it('pedir la fila del vecino por id devuelve nada', async () => {
    const ajeno = await como(unNegocio.tenantId, () =>
      prisma.tenant.findFirst({ where: { id: elOtro.tenantId } }),
    );

    expect(ajeno).toBeNull();
  });

  /**
   * Las escrituras pasan por `WITH CHECK` y no por `USING`: con una sola de las
   * dos mitades, una escritura cruzada pasaría aunque la lectura estuviera
   * tapada.
   */
  it('no se puede escribir sobre una fila del vecino', async () => {
    const tocadas = await como(unNegocio.tenantId, () =>
      prisma.branch.updateMany({
        where: { tenantId: elOtro.tenantId },
        data: { name: 'pisada' },
      }),
    );

    expect(tocadas.count).toBe(0);
  });

  /**
   * ⚠️ Va con `createMany` y no con `create`, y no es un capricho.
   *
   * `create` termina en un `INSERT ... RETURNING`, y ese `RETURNING` lo filtra
   * el `USING` de la política: la fila entra y después no se puede leer, así
   * que Prisma falla igual. El test pasaba **con `WITH CHECK` desactivado** —lo
   * comprobamos mutando la política— o sea que no probaba nada de lo que dice
   * probar. `createMany` no lee nada de vuelta, así que lo único que puede
   * rechazarlo es el `WITH CHECK`.
   */
  it('no se puede crear una fila a nombre del vecino', async () => {
    await expect(
      como(unNegocio.tenantId, () =>
        prisma.branch.createMany({
          data: [{ tenantId: elOtro.tenantId, name: 'infiltrada' }],
        }),
      ),
    ).rejects.toThrow();

    expect(await prisma.branch.count({ where: { name: 'infiltrada' } })).toBe(
      0,
    );
  });

  it('tampoco borrar', async () => {
    const borradas = await como(unNegocio.tenantId, () =>
      prisma.employee.deleteMany({ where: { tenantId: elOtro.tenantId } }),
    );

    expect(borradas.count).toBe(0);

    const siguenAhi = await prisma.employee.count({
      where: { tenantId: elOtro.tenantId },
    });

    expect(siguenAhi).toBeGreaterThan(0);
  });

  // ── Que no rompa lo que tiene que funcionar ───────────────────────────────

  it('cada negocio sí ve lo suyo', async () => {
    const deAna = await como(unNegocio.tenantId, () =>
      prisma.tenant.findFirst({ select: { businessName: true } }),
    );

    const deBeto = await como(elOtro.tenantId, () =>
      prisma.tenant.findFirst({ select: { businessName: true } }),
    );

    expect(deAna?.businessName).toBe('Peluquería Ana');
    expect(deBeto?.businessName).toBe('Peluquería Beto');
  });

  /**
   * Sin negocio resuelto, las políticas dejan pasar. Es la misma puerta que
   * `runWithoutTenant()` —login, webhooks, jobs, seeds— y tiene que seguir
   * abierta o la mitad del sistema no arranca.
   */
  it('runWithoutTenant sigue viendo todo', async () => {
    const todos = await tenantContext.runWithoutTenant(
      async () => await prisma.tenant.findMany({ select: { id: true } }),
    );

    expect(todos.length).toBeGreaterThanOrEqual(2);
  });

  it('el setting no se queda pegado: después de un request se ve todo', async () => {
    await como(unNegocio.tenantId, () => prisma.tenant.findMany());

    const despues = await prisma.tenant.findMany({ select: { id: true } });

    expect(despues.length).toBeGreaterThanOrEqual(2);
  });

  // ── El modo de fallar que da más miedo ────────────────────────────────────

  /**
   * ⚠️ Veinte consultas a la vez sobre un pool que no tiene veinte conexiones,
   * así que la mayoría espera en la cola. Ese es exactamente el caso en el que
   * leer el contexto **tarde** —dentro del callback de `connect`, o en el
   * evento `acquire`— devuelve el del request que soltó la conexión y no el del
   * que la pidió: le mandaríamos a Postgres el negocio de otra persona.
   *
   * Si `TenantPool` alguna vez deja de leer el tenant al principio de
   * `connect()`, este test se pone en rojo.
   */
  it('bajo contención, cada consulta ve su propio negocio', async () => {
    const negocios = [unNegocio.tenantId, elOtro.tenantId];

    const resultados = await Promise.all(
      Array.from({ length: 20 }, (_, i) => {
        const esperado = negocios[i % 2];

        return como(esperado, async () => {
          const filas = await prisma.tenant.findMany({ select: { id: true } });

          return { esperado, visto: filas.map((row) => row.id) };
        });
      }),
    );

    for (const { esperado, visto } of resultados) {
      expect(visto).toEqual([esperado]);
    }
  });
});
