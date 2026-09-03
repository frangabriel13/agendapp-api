import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import request from 'supertest';
import type { PrismaService } from '../src/prisma/prisma.service';
import { testDatabaseUrl } from './utils/test-database';
import {
  auth,
  createTestApp,
  registerTenant,
  resetDatabase,
  switchPlan,
  type RegisteredTenant,
  type TestApp,
} from './utils/e2e-app';

/** Lunes; el horario de atención se carga para todos los días igual. */
const DIA = '2026-09-07';
const DAY_OF_WEEK = 1;

/** `"10:00"` de Buenos Aires como instante ISO (UTC-3 todo el año). */
function enBuenosAires(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);

  return `${DIA}T${String(h + 3).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;
}

/**
 * El doble-booking, probado como pasa de verdad: **dos requests a la vez**.
 *
 * Los tests que ya existían reservan una y después la otra, así que la segunda
 * la rechaza la validación previa. Eso está bien y no prueba lo que importa: el
 * repo entero se apoya en que quien desempata es el **EXCLUDE constraint de
 * Postgres**, porque dos requests simultáneas pasan las dos la validación —
 * cuando miran, todavía no hay nada que las moleste.
 *
 * Estos tests son la única forma de recorrer ese camino. Si alguien "optimiza"
 * el `catch` de `scheduleConflictOr`, o mueve la validación adentro de la
 * transacción creyendo que eso alcanza, acá se ve.
 */
describe('Concurrencia: el doble-booking lo impide la base (e2e)', () => {
  let app: TestApp;
  let prisma: PrismaService;
  let tenant: RegisteredTenant;
  let branchId: string;
  let serviceId: string;
  let employeeId: string;

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp());
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();
  const asOwner = () => auth(tenant.accessToken);

  /** Conexiones crudas con transacciones a medio camino, para poder cerrarlas. */
  const abiertas: Client[] = [];

  afterEach(async () => {
    for (const client of abiertas.splice(0)) {
      // `ROLLBACK` sobre una transacción ya commiteada es un no-op con warning:
      // no hace falta saber en cuál de los dos estados quedó.
      await client.query('ROLLBACK').catch(() => undefined);
      await client.end().catch(() => undefined);
    }
  });

  async function createBranch(): Promise<string> {
    const response = await request(server())
      .post('/branches')
      .set(...asOwner())
      .send({ name: `Sucursal ${randomUUID().slice(0, 8)}` })
      .expect(201);

    const id = (response.body as { id: string }).id;

    await request(server())
      .put(`/branches/${id}/business-hours`)
      .set(...asOwner())
      .send({
        days: Array.from({ length: 7 }, (_, dayOfWeek) => ({
          dayOfWeek,
          opensAt: '09:00',
          closesAt: '18:00',
        })),
      })
      .expect(200);

    return id;
  }

  async function createService(
    body: Record<string, unknown> = {},
  ): Promise<string> {
    const response = await request(server())
      .post('/services')
      .set(...asOwner())
      .send({
        name: `Servicio ${randomUUID().slice(0, 8)}`,
        durationMinutes: 60,
        priceCents: 100_000,
        ...body,
      })
      .expect(201);

    return (response.body as { id: string }).id;
  }

  async function createProfessional(): Promise<string> {
    const invitation = await request(server())
      .post('/employees')
      .set(...asOwner())
      .send({
        email: `${randomUUID()}@e2e.test`,
        firstName: 'Lucía',
        lastName: 'Fernández',
        role: 'PROFESSIONAL',
        branchIds: [branchId],
      })
      .expect(201);

    const body = invitation.body as {
      employee: { id: string };
      activationUrl: string;
    };

    await request(server())
      .post('/employees/activate')
      .send({
        token: new URL(body.activationUrl).searchParams.get('token'),
        password: 'claveNueva123',
      })
      .expect(204);

    await request(server())
      .put(`/employees/${body.employee.id}/schedules`)
      .set(...asOwner())
      .send({
        shifts: Array.from({ length: 7 }, (_, dayOfWeek) => ({
          branchId,
          dayOfWeek,
          startsAt: '09:00',
          endsAt: '18:00',
        })),
      })
      .expect(200);

    return body.employee.id;
  }

  async function assign(service: string, employees: string[]): Promise<void> {
    await request(server())
      .put(`/services/${service}/employees`)
      .set(...asOwner())
      .send({
        assignments: employees.map((id) => ({ employeeId: id, branchId })),
      })
      .expect(200);
  }

  async function createCustomer(): Promise<string> {
    const response = await request(server())
      .post('/customers')
      .set(...asOwner())
      .send({
        firstName: 'Cliente',
        phone: `11 ${Math.floor(1000 + Math.random() * 8999)}-${Math.floor(
          1000 + Math.random() * 8999,
        )}`,
      })
      .expect(201);

    return (response.body as { id: string }).id;
  }

  const book = (body: Record<string, unknown>) =>
    request(server())
      .post('/appointments')
      .set(...asOwner())
      .send({
        branchId,
        employeeId,
        serviceIds: [serviceId],
        startsAt: enBuenosAires('10:00'),
        ...body,
      });

  beforeEach(async () => {
    await resetDatabase(prisma);
    tenant = await registerTenant(app, 'Peluquería Ana');
    await switchPlan(prisma, tenant.tenantId, 'avanzado');
    branchId = await createBranch();
    serviceId = await createService();
    employeeId = await createProfessional();
    await assign(serviceId, [employeeId]);
  });

  /**
   * Deja el hueco tomado por una transacción **sin cerrar**, y devuelve con qué
   * cerrarla.
   *
   * Es lo que convierte esta prueba en determinista. Dos `POST` disparados a la
   * vez casi nunca se pisan de verdad: el primero termina antes de que el
   * segundo llegue a insertar, así que lo rechaza la validación previa y el
   * EXCLUDE constraint —que es lo que se quiere probar— no llega a intervenir.
   * Con una transacción abierta, el `INSERT` de la app **queda bloqueado** por
   * Postgres hasta que esta commitee, y ahí sí se choca contra el constraint.
   *
   * Va por `pg` crudo y con el rol dueño porque necesita controlar cuándo se
   * commitea, y eso Prisma no lo expone.
   */
  async function ocuparElHuecoSinCommitear(startsAt: string): Promise<{
    commit: () => Promise<void>;
  }> {
    const client = new Client({ connectionString: testDatabaseUrl() });
    await client.connect();

    const customerId = await createCustomer();
    const endsAt = new Date(
      new Date(startsAt).getTime() + 60 * 60 * 1000,
    ).toISOString();

    await client.query('BEGIN');
    await client.query(
      `INSERT INTO appointments
         (tenant_id, branch_id, employee_id, customer_id,
          starts_at, ends_at, status, total_price_cents, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'confirmed', 100000, now())`,
      [tenant.tenantId, branchId, employeeId, customerId, startsAt, endsAt],
    );

    // Si el test falla antes de commitear, esta transacción quedaría abierta
    // sosteniendo locks sobre `appointments`, y el `TRUNCATE` del `beforeEach`
    // siguiente se quedaría esperando **para siempre**: la corrida se cuelga sin
    // decir por qué. (Pasó.) Por eso se registra la limpieza acá y no se confía
    // en que el camino feliz llegue al `commit`.
    abiertas.push(client);

    return {
      commit: async () => {
        await client.query('COMMIT');
      },
    };
  }

  /**
   * Espera a que haya una consulta esperando un lock en la base de tests.
   *
   * Reemplaza al `setTimeout` de "dormir y cruzar los dedos": lo que hace falta
   * saber es que el `INSERT` de la app **ya llegó y está bloqueado**, y eso se
   * puede preguntar en vez de estimarlo.
   */
  async function esperarABloqueo(): Promise<void> {
    const client = new Client({ connectionString: testDatabaseUrl() });
    await client.connect();

    try {
      for (let intento = 0; intento < 100; intento += 1) {
        const { rows } = await client.query<{ n: string }>(
          `SELECT count(*) AS n FROM pg_stat_activity
           WHERE datname = current_database()
             AND wait_event_type = 'Lock'
             AND query ILIKE '%appointments%'`,
        );

        if (Number(rows[0].n) > 0) {
          return;
        }

        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      throw new Error(
        'El INSERT de la app nunca quedó bloqueado: la carrera no se produjo',
      );
    } finally {
      await client.end();
    }
  }

  // ── El profesional ────────────────────────────────────────────────────────

  /**
   * ⚠️ **La carrera de verdad, forzada.**
   *
   * Otra transacción tiene el hueco tomado y sin commitear, así que el `INSERT`
   * de la app pasa la validación previa (todavía no ve nada) y después se
   * queda esperando en la base. Cuando la otra commitea, Postgres lo rechaza
   * con `23P01`.
   *
   * Es el único camino que ejerce el EXCLUDE constraint, y por lo tanto el
   * único que prueba que `scheduleConflictOr` lo traduce: Prisma **no** traduce
   * las violaciones de EXCLUDE, así que sin ese `catch` esto es un 500.
   */
  it('el hueco tomado por una transacción abierta da 409, no 500', async () => {
    const startsAt = enBuenosAires('10:00');
    const bloqueo = await ocuparElHuecoSinCommitear(startsAt);

    // ⚠️ El `.then()` NO es ruido: los objetos de supertest son perezosos y no
    // mandan nada hasta que alguien los espera. Sin esto el pedido saldría
    // recién en el `await` de abajo —o sea, después del `commit`— y el test
    // pasaría sin haber provocado ninguna carrera.
    const enviado = book({ customerId: await createCustomer(), startsAt }).then(
      (response) => response,
    );

    await esperarABloqueo();
    await bloqueo.commit();

    const response = await enviado;

    expect(response.status).toBe(409);
  });

  /**
   * ⚠️ El test que sostiene la promesa más cara del producto.
   *
   * Las dos requests salen a la vez, así que las dos pasan `assertSlotIsFree`:
   * en el momento de mirar, ninguna de las dos existe todavía. Quien desempata
   * es el EXCLUDE constraint, y lo que lo traduce a un 409 es el `catch` de
   * `insertAppointment` — Prisma **no** traduce las violaciones de EXCLUDE, así
   * que sin ese `catch` esto sería un 500.
   */
  /** El 409 tiene que ser legible, no un 500 con el nombre de un constraint. */
  it('el que pierde recibe un mensaje que se entiende', async () => {
    const [uno, otro] = await Promise.all([
      book({ customerId: await createCustomer() }),
      book({ customerId: await createCustomer() }),
    ]);

    const perdedor = uno.status === 409 ? uno : otro;
    const body = perdedor.body as { message: string };

    expect(perdedor.status).toBe(409);
    expect(body.message.toLowerCase()).not.toContain('constraint');
    expect(body.message.length).toBeGreaterThan(10);
  });

  /** Cinco a la vez tampoco: no es que "casi siempre" entre una. */
  it('cinco simultáneas: entra una sola', async () => {
    const clientes = await Promise.all(
      Array.from({ length: 5 }, () => createCustomer()),
    );

    const respuestas = await Promise.all(
      clientes.map((customerId) => book({ customerId })),
    );

    expect(respuestas.filter((r) => r.status === 201)).toHaveLength(1);
    expect(respuestas.filter((r) => r.status === 409)).toHaveLength(4);
  });

  /** Horarios distintos no se estorban: el constraint es por solapamiento. */
  it('dos horarios distintos entran los dos', async () => {
    const [uno, otro] = await Promise.all([
      book({
        customerId: await createCustomer(),
        startsAt: enBuenosAires('10:00'),
      }),
      book({
        customerId: await createCustomer(),
        startsAt: enBuenosAires('11:00'),
      }),
    ]);

    expect([uno.status, otro.status]).toEqual([201, 201]);
  });

  // ── El recurso ────────────────────────────────────────────────────────────

  /**
   * El segundo EXCLUDE constraint, el de `appointment_resources`, que se apoya
   * en la copia de `starts_at`/`ends_at` que escribe `syncResourceMirror`.
   *
   * Acá los turnos son de **dos profesionales distintos**, así que el
   * constraint de empleados no los toca: lo único que puede rechazar al segundo
   * es que los dos necesiten la misma camilla.
   */
  it('dos profesionales libres pero un solo recurso: entra uno solo', async () => {
    const otroEmpleado = await createProfessional();

    const recurso = await request(server())
      .post('/resources')
      .set(...asOwner())
      .send({ branchId, name: 'Camilla 1' })
      .expect(201);

    const recursoId = (recurso.body as { id: string }).id;
    const servicioConRecurso = await createService();

    await assign(servicioConRecurso, [employeeId, otroEmpleado]);
    await request(server())
      .put(`/services/${servicioConRecurso}/resources`)
      .set(...asOwner())
      .send({ resourceIds: [recursoId] })
      .expect(200);

    const [uno, otro] = await Promise.all([
      book({
        customerId: await createCustomer(),
        employeeId,
        serviceIds: [servicioConRecurso],
      }),
      book({
        customerId: await createCustomer(),
        employeeId: otroEmpleado,
        serviceIds: [servicioConRecurso],
      }),
    ]);

    const estados = [uno.status, otro.status].sort((a, b) => a - b);

    expect(estados).toEqual([201, 409]);
  });

  it('el día de la semana correcto importa: DAY_OF_WEEK es lunes', () => {
    expect(new Date(`${DIA}T12:00:00Z`).getUTCDay()).toBe(DAY_OF_WEEK);
  });
});
