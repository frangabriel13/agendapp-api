import { Pool, type PoolClient } from 'pg';

/**
 * El nombre del *setting* de Postgres donde viaja el negocio del request.
 *
 * Tiene que decir **exactamente lo mismo** que el `current_setting(...)` de las
 * políticas RLS (migración `rls_tenant_isolation`). Si se cambia acá y no allá,
 * las políticas dejan de encontrar el valor y —por cómo están escritas— pasan a
 * dejar ver todo. El fallo sería mudo.
 */
export const TENANT_SETTING = 'app.current_tenant';

/** Marca en el cliente de `pg` qué valor tiene puesto, para no repetirlo. */
const APPLIED = Symbol('tenantSetting');

type TrackedClient = PoolClient & { [APPLIED]?: string };

/**
 * El pool que le cuenta a Postgres de qué negocio es cada consulta.
 *
 * Es la mitad que le falta a RLS: las políticas comparan `tenant_id` contra un
 * setting de sesión, y alguien tiene que ponerlo. Acá se pone **en cada
 * checkout de conexión**, que es el único momento en el que se puede garantizar
 * que el valor y la consulta van por el mismo cable.
 *
 * ⚠️ **El tenant se lee al principio de `connect()`, sincrónicamente, y no
 * después.** Es la línea de la que depende todo: `connect()` corre en el
 * contexto de quien pide la conexión, pero si el pool está lleno el callback se
 * resuelve más tarde —posiblemente desde el `release()` de OTRO request— y ahí
 * el `AsyncLocalStorage` ya devuelve el contexto equivocado. Leerlo tarde
 * significaría mandarle a Postgres el negocio de otra persona. Hay una sonda de
 * concurrencia en los tests que fija esto.
 *
 * **Sin tenant resuelto se limpia el setting**, no se deja el anterior. Con el
 * setting vacío las políticas dejan pasar todo, que es exactamente lo que
 * `runWithoutTenant()` significa —auth previo al login, webhooks, jobs— y lo
 * mismo que ya hace la extension de Prisma. Dejar el valor anterior sería peor
 * que no tener RLS: un job vería la base con los ojos del último request.
 */
export class TenantPool extends Pool {
  constructor(
    config: ConstructorParameters<typeof Pool>[0],
    /**
     * De dónde sale el negocio del request. Una función y no el
     * `AsyncLocalStorage` para que este archivo no tenga que saber cómo está
     * guardado el contexto — lo único que le importa es **cuándo** preguntarlo.
     */
    private readonly currentTenantId: () => string,
  ) {
    super(config);
  }

  connect(): Promise<PoolClient>;
  connect(
    callback: (
      err: Error | undefined,
      client: PoolClient | undefined,
      done: (release?: unknown) => void,
    ) => void,
  ): void;
  connect(
    callback?: (
      err: Error | undefined,
      client: PoolClient | undefined,
      done: (release?: unknown) => void,
    ) => void,
  ): Promise<PoolClient> | void {
    // Acá, ya. Ver el aviso del docstring: leerlo más abajo es un bug silencioso.
    const tenantId = this.currentTenantId();

    if (!callback) {
      return super
        .connect()
        .then((client) => this.applyTenant(client, tenantId));
    }

    // La forma con callback la usa `pool.query()`, que es por donde pasa toda
    // consulta suelta de Prisma. Sin cubrirla, el setting solo se aplicaría en
    // las transacciones.
    super.connect((err, client, done) => {
      if (err || !client) {
        callback(err, client, done);

        return;
      }

      this.applyTenant(client, tenantId).then(
        (ready) => callback(undefined, ready, done),
        (error: Error) => callback(error, client, done),
      );
    });
  }

  /**
   * Deja el setting con el valor que corresponde y devuelve el mismo cliente.
   *
   * Se saltea la consulta si la conexión ya lo tiene puesto: en un pool
   * caliente sirviendo a un mismo negocio, eso evita un ida y vuelta por cada
   * consulta. Es seguro porque nadie más toca este setting.
   */
  private async applyTenant(
    client: PoolClient,
    tenantId: string,
  ): Promise<PoolClient> {
    const tracked = client as TrackedClient;

    if (tracked[APPLIED] === tenantId) {
      return client;
    }

    // `set_config` y no `SET`: el segundo no acepta parámetros, así que habría
    // que interpolar el uuid en el SQL a mano.
    await client.query({
      text: `SELECT set_config('${TENANT_SETTING}', $1, false)`,
      values: [tenantId],
    });

    tracked[APPLIED] = tenantId;

    return client;
  }
}
