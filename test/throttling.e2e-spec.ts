import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { RATE_LIMIT_HEADERS, THROTTLERS } from '../src/config/throttler.config';
import type { PrismaService } from '../src/prisma/prisma.service';
import {
  auth,
  createTestApp,
  registerTenant,
  type RegisteredTenant,
  resetDatabase,
  resetThrottling,
  switchPlan,
  TEST_PASSWORD,
  type TestApp,
} from './utils/e2e-app';

const MS_PER_DAY = 24 * 60 * 60 * 1_000;
const BA_OFFSET_HOURS = 3;

/** Los que declara `THROTTLERS`, para no repetirlos escritos a mano. */
const GLOBAL_SHORT = THROTTLERS.find((t) => t.name === 'short')!.limit;
const GLOBAL_LONG = THROTTLERS.find((t) => t.name === 'long')!.limit;

/** `CREDENTIALS_THROTTLE` en `auth.controller.ts`. */
const LOGINS_POR_MINUTO = 5;

/** El `short` de `BOOKING_THROTTLE` en `public.controller.ts`. */
const RESERVAS_POR_MINUTO = 3;

function businessDate(daysAhead: number): string {
  const instant = new Date(
    Date.now() - BA_OFFSET_HOURS * 60 * 60 * 1_000 + daysAhead * MS_PER_DAY,
  );

  return instant.toISOString().slice(0, 10);
}

function at(dateOnly: string, hhmm: string): string {
  const [hours, minutes] = hhmm.split(':').map(Number);

  return `${dateOnly}T${String(hours + BA_OFFSET_HOURS).padStart(2, '0')}:${String(
    minutes,
  ).padStart(2, '0')}:00.000Z`;
}

/**
 * El rate limiting, con el guard **prendido**.
 *
 * Es el único archivo que corre así: en el resto el límite está apagado porque
 * la suite hace decenas de registros y logins por minuto y se caería sola por
 * un motivo que no tiene nada que ver con lo que prueba.
 *
 * Todos los límites que se ejercitan acá son de **ventana de un minuto o más**
 * (5 logins/minuto, 3 reservas/minuto). Los de un segundo se verifican por los
 * headers que la respuesta declara, no agotándolos: agotar diez pedidos "en el
 * mismo segundo" convierte al reloj de la máquina en parte del test, y ese es
 * el tipo de test que anda en la notebook y parpadea en CI.
 */
describe('Rate limiting (e2e)', () => {
  let app: TestApp;
  let prisma: PrismaService;
  let tenant: RegisteredTenant;
  let slug: string;
  let branchId: string;
  let serviceId: string;

  const DIA = businessDate(10);

  beforeAll(async () => {
    ({ app, prisma } = await createTestApp({ throttling: true }));
  });

  afterAll(async () => {
    await app.close();
  });

  const server = () => app.getHttpServer();
  const asOwner = () => auth(tenant.accessToken);

  // ── Armado del escenario ──────────────────────────────────────────────────

  async function setUpPortal(): Promise<void> {
    const branch = await request(server())
      .post('/branches')
      .set(...asOwner())
      .send({ name: 'Sucursal Centro' })
      .expect(201);

    branchId = (branch.body as { id: string }).id;

    await request(server())
      .put(`/branches/${branchId}/business-hours`)
      .set(...asOwner())
      .send({
        days: Array.from({ length: 7 }, (_, dayOfWeek) => ({
          dayOfWeek,
          opensAt: '09:00',
          closesAt: '18:00',
        })),
      })
      .expect(200);

    const service = await request(server())
      .post('/services')
      .set(...asOwner())
      .send({
        name: 'Corte',
        durationMinutes: 60,
        priceCents: 100_000,
      })
      .expect(201);

    serviceId = (service.body as { id: string }).id;

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

    const employeeId = (invitation.body as { employee: { id: string } })
      .employee.id;

    await request(server())
      .put(`/employees/${employeeId}/schedules`)
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

    await request(server())
      .put(`/services/${serviceId}/employees`)
      .set(...asOwner())
      .send({ assignments: [{ employeeId, branchId }] })
      .expect(200);

    const row = await prisma.tenant.findUniqueOrThrow({
      where: { id: tenant.tenantId },
      select: { slug: true },
    });

    slug = row.slug;
  }

  const login = (password: string): request.Test =>
    request(server())
      .post('/auth/login')
      .send({ email: tenant.email, password });

  const reservar = (hhmm: string): request.Test =>
    request(server())
      .post(`/public/${slug}/appointments`)
      .send({
        branchId,
        serviceIds: [serviceId],
        startsAt: at(DIA, hhmm),
        customer: { firstName: 'María', phone: '11 5555-1234' },
      });

  beforeEach(async () => {
    await resetDatabase(prisma);
    tenant = await registerTenant(app);
    await switchPlan(prisma, tenant.tenantId, 'avanzado');
    await setUpPortal();

    // Al final y no al principio: lo que gastó el armado no puede contarle al
    // test, y el armado son ocho pedidos.
    resetThrottling(app);
  });

  // ── Credenciales ──────────────────────────────────────────────────────────

  describe('Login', () => {
    it(`el intento ${LOGINS_POR_MINUTO + 1} del minuto se rechaza`, async () => {
      for (let i = 0; i < LOGINS_POR_MINUTO; i += 1) {
        await login('la-que-no-es').expect(401);
      }

      await login('la-que-no-es').expect(429);
    });

    /**
     * Lo que hace útil al límite: cuenta **intentos**, no fallos. Si solo
     * contara los rechazados, un ataque de diccionario tendría barra libre
     * hasta el momento exacto en que acierta — que es justo cuando ya no
     * importa cortarlo.
     */
    it('acertar la contraseña no saltea el límite', async () => {
      for (let i = 0; i < LOGINS_POR_MINUTO; i += 1) {
        await login('la-que-no-es').expect(401);
      }

      await login(TEST_PASSWORD).expect(429);
    });

    /**
     * En cuánto se puede reintentar es la única información accionable de un
     * 429, y viaja en `Retry-After-short`: **con sufijo**, igual que los
     * `X-RateLimit-*`, porque el throttler tiene nombre. Escrito a secas, el
     * header no existe — y así estuvo en `RATE_LIMIT_HEADERS` hasta que este
     * archivo lo miró.
     */
    it('el rechazo dice en cuánto se puede reintentar', async () => {
      for (let i = 0; i < LOGINS_POR_MINUTO; i += 1) {
        await login('la-que-no-es').expect(401);
      }

      const response = await login('la-que-no-es').expect(429);

      expect(Number(response.headers['retry-after-short'])).toBeGreaterThan(0);
    });

    it('los intentos que quedan bajan de a uno', async () => {
      const primero = await login('la-que-no-es').expect(401);
      const segundo = await login('la-que-no-es').expect(401);

      const restantes = (response: request.Response): number =>
        Number(response.headers['x-ratelimit-remaining-short']);

      expect(restantes(primero)).toBe(LOGINS_POR_MINUTO - 1);
      expect(restantes(segundo)).toBe(LOGINS_POR_MINUTO - 2);
    });
  });

  // ── Reserva pública ───────────────────────────────────────────────────────

  describe('Reserva desde el portal', () => {
    /**
     * El límite que sostiene una promesa cara: cada reserva **le ocupa un hueco
     * al negocio**, así que el techo de lectura no alcanza —cincuenta reservas
     * son cincuenta pedidos legítimos— y hace falta uno propio.
     */
    it(`la reserva ${RESERVAS_POR_MINUTO + 1} del minuto se rechaza`, async () => {
      const horarios = ['09:00', '10:00', '11:00', '12:00'];

      for (const hhmm of horarios.slice(0, RESERVAS_POR_MINUTO)) {
        await reservar(hhmm).expect(201);
      }

      await reservar(horarios[RESERVAS_POR_MINUTO]).expect(429);
    });

    /**
     * Un 429 tiene que cortar **antes** del handler. Si el guard corriera
     * después, el turno quedaría creado y el límite sería decorativo: la agenda
     * se llenaría igual, solo que sin avisarle a nadie.
     */
    it('la reserva rechazada no ocupa ningún hueco', async () => {
      const horarios = ['09:00', '10:00', '11:00', '12:00'];

      for (const hhmm of horarios.slice(0, RESERVAS_POR_MINUTO)) {
        await reservar(hhmm).expect(201);
      }

      await reservar(horarios[RESERVAS_POR_MINUTO]).expect(429);

      const turnos = await prisma.appointment.count({
        where: { tenantId: tenant.tenantId },
      });

      expect(turnos).toBe(RESERVAS_POR_MINUTO);
    });

    /** Leer el portal es mucho más barato que reservar, y el límite lo refleja. */
    it('mirar los horarios sigue andando después de agotar las reservas', async () => {
      const horarios = ['09:00', '10:00', '11:00', '12:00'];

      for (const hhmm of horarios.slice(0, RESERVAS_POR_MINUTO)) {
        await reservar(hhmm).expect(201);
      }

      await reservar(horarios[RESERVAS_POR_MINUTO]).expect(429);

      await request(server())
        .get(`/public/${slug}/availability`)
        .query({ branchId, serviceIds: serviceId, date: DIA })
        .expect(200);
    });
  });

  // ── Un contador por endpoint ──────────────────────────────────────────────

  describe('Los contadores no se comparten', () => {
    /**
     * Cada handler lleva el suyo. Es lo que impide que alguien tire abajo la
     * API entera martillando el endpoint más barato que encuentre: agotar uno
     * no deja sin servicio a los demás.
     */
    it('agotar el login no cierra el portal', async () => {
      for (let i = 0; i < LOGINS_POR_MINUTO; i += 1) {
        await login('la-que-no-es').expect(401);
      }

      await login('la-que-no-es').expect(429);

      await request(server()).get(`/public/${slug}`).expect(200);
    });

    it('agotar el login no voltea al que ya tiene token', async () => {
      for (let i = 0; i < LOGINS_POR_MINUTO; i += 1) {
        await login('la-que-no-es').expect(401);
      }

      await login('la-que-no-es').expect(429);

      await request(server())
        .get('/customers')
        .set(...asOwner())
        .expect(200);
    });
  });

  // ── Qué límite aplica a qué ───────────────────────────────────────────────

  describe('Los límites que declara cada respuesta', () => {
    /**
     * Un endpoint sin `@Throttle` propio hereda el global. Se comprueba por el
     * header y no agotándolo: son diez pedidos en un segundo, y hacer depender
     * el resultado de cuánto tarda la máquina es cambiar una garantía por una
     * ruleta.
     */
    it('un endpoint sin límite propio usa el global', async () => {
      const response = await request(server())
        .get('/customers')
        .set(...asOwner())
        .expect(200);

      expect(response.headers['x-ratelimit-limit-short']).toBe(
        String(GLOBAL_SHORT),
      );
      expect(response.headers['x-ratelimit-limit-long']).toBe(
        String(GLOBAL_LONG),
      );
    });

    it('el login declara el suyo, más ajustado que el global', async () => {
      const response = await login('la-que-no-es').expect(401);

      expect(response.headers['x-ratelimit-limit-short']).toBe(
        String(LOGINS_POR_MINUTO),
      );
    });

    /**
     * El webhook va para el otro lado: Mercado Pago avisa en ráfagas y
     * reintenta, así que su límite es **más alto** que el global. Si el
     * `@Throttle` del handler dejara de pisar al global, los reintentos de MP
     * empezarían a rebotar con 429 y se perderían pagos.
     */
    it('el webhook declara un límite más alto que el global', async () => {
      const response = await request(server())
        .post('/webhooks/mercadopago')
        .send({ type: 'merchant_order', data: { id: 'lo-que-sea' } })
        .expect(200);

      expect(
        Number(response.headers['x-ratelimit-limit-short']),
      ).toBeGreaterThan(GLOBAL_SHORT);
    });

    /**
     * Los headers que salen y los que CORS deja leer tienen que ser los
     * mismos. `@nestjs/throttler` le pega **el nombre del throttler como
     * sufijo** a cada uno, así que agregar un límite nombrado agrega headers:
     * si `RATE_LIMIT_HEADERS` no los acompaña, el navegador los recibe y no se
     * los deja leer al JavaScript. El síntoma sería mudo — el header viaja
     * igual— y este test es lo único que lo grita.
     *
     * Se mira una respuesta **rechazada**: el `Retry-After-*` sale solo ahí, y
     * es justamente el que estaba mal en la lista. Con una respuesta exitosa,
     * este test pasaba con el bug puesto.
     */
    it('todo header de rate limit que sale está en la lista que CORS expone', async () => {
      for (let i = 0; i < LOGINS_POR_MINUTO; i += 1) {
        await login('la-que-no-es').expect(401);
      }

      const response = await login('la-que-no-es').expect(429);

      const expuestos = RATE_LIMIT_HEADERS.map((name) => name.toLowerCase());
      const emitidos = Object.keys(response.headers).filter(
        (name) =>
          name.startsWith('x-ratelimit-') || name.startsWith('retry-after'),
      );

      expect(emitidos).toContain('retry-after-short');
      expect(expuestos).toEqual(expect.arrayContaining(emitidos));
    });
  });
});
