import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  ThrottlerGuard,
  ThrottlerStorage,
  type ThrottlerStorageService,
} from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { MAIL_PROVIDER } from '../../src/common/mail';
import { PAYMENT_PROVIDER } from '../../src/modules/payments/providers/payment-provider.types';
import type { SandboxPaymentProvider } from '../../src/modules/payments/providers/sandbox-payment.provider';
import { PrismaService } from '../../src/prisma/prisma.service';
import { RecordingMailProvider } from './recording-mail.provider';

/** La app tipada con el server de supertest: sin esto `getHttpServer()` es `any`. */
export type TestApp = INestApplication<App>;

export interface E2EContext {
  app: TestApp;
  prisma: PrismaService;
  /** La casilla donde caen los mails en vez de salir. */
  mail: RecordingMailProvider;
  /**
   * El proveedor de pagos de mentira. Es el default de la config, así que no
   * hace falta reemplazarlo: se agarra el que armó el módulo.
   */
  payments: SandboxPaymentProvider;
}

/** Contraseña válida según las reglas del DTO (8+, con letra y número). */
export const TEST_PASSWORD = 'Password123!';

export interface TestAppOptions {
  /**
   * Dejar el rate limiting **prendido**.
   *
   * Solo lo usa `throttling.e2e-spec.ts`. En cualquier otro archivo tiene que
   * quedar apagado: los tests hacen decenas de registros y logins por minuto y
   * el límite real de `/auth/login` es de 5, así que la suite se caería sola
   * por un motivo que no tiene nada que ver con lo que está probando.
   */
  throttling?: boolean;
}

/**
 * Levanta la app real: mismos módulos, mismo `ValidationPipe`, mismo filtro de
 * excepciones y los mismos guards globales que en producción (por eso el pipe y
 * el filtro se registran en `AppModule` y no en `main.ts`).
 *
 * Se desactivan dos cosas. El rate limiting, salvo que se pida lo contrario con
 * `{ throttling: true }`. Y el envío de mails, que se reemplaza por una casilla
 * en memoria — de ahí salen los tokens de reset y verificación, que en la base
 * están hasheados y no se pueden leer.
 */
export async function createTestApp(
  options: TestAppOptions = {},
): Promise<E2EContext> {
  if (!options.throttling) {
    jest.spyOn(ThrottlerGuard.prototype, 'canActivate').mockResolvedValue(true);
  }

  const mail = new RecordingMailProvider();

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(MAIL_PROVIDER)
    .useValue(mail)
    .compile();

  const app = moduleRef.createNestApplication<TestApp>({ logger: false });
  await app.init();

  return {
    app,
    prisma: app.get(PrismaService),
    mail,
    payments: app.get<SandboxPaymentProvider>(PAYMENT_PROVIDER),
  };
}

/**
 * Pone en cero los contadores de rate limit.
 *
 * Solo hace falta con `{ throttling: true }`, y ahí es imprescindible: el
 * tracker es la IP, y en los tests **todos los pedidos vienen de la misma**.
 * Sin esto, lo que gasta el armado de un test (registrar el negocio, invitar al
 * empleado) se le descuenta al siguiente, y el archivo empieza a fallar por el
 * orden en que corren los tests en vez de por lo que prueban.
 *
 * ⚠️ **Los timers van antes que el Map, y no al revés.** Cada pedido programa
 * un `setTimeout` que al vencer entra a descontar el hit leyendo su fila del
 * storage; vaciando el Map primero, esos timers se despiertan sobre una fila
 * que ya no está y revientan con `Cannot destructure property 'totalHits'`
 * —desde un timer, o sea lejísimos del test que lo causó—. `onApplicationShutdown`
 * es lo que los cancela: se llama por su efecto, no porque acá haya un
 * apagado.
 */
export function resetThrottling(app: TestApp): void {
  const storage = app.get<ThrottlerStorageService>(ThrottlerStorage);

  storage.onApplicationShutdown();
  storage.storage.clear();
}

/**
 * Vacía las tablas de negocio entre tests. Descubre las tablas sola, así que no
 * hay que actualizar una lista cada vez que aparece un modelo nuevo.
 *
 * Deja `plans` (catálogo global que carga el seed) y `_prisma_migrations`.
 */
export async function resetDatabase(prisma: PrismaService): Promise<void> {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename
    FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN ('_prisma_migrations', 'plans')
  `;

  if (tables.length === 0) {
    return;
  }

  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`,
  );
}

export interface RegisteredTenant {
  email: string;
  password: string;
  accessToken: string;
  refreshToken: string;
  tenantId: string;
  userId: string;
  employeeId: string;
  businessName: string;
}

/** Registra un negocio nuevo y devuelve tokens + ids, listo para usar. */
export async function registerTenant(
  app: TestApp,
  businessName = 'Negocio E2E',
): Promise<RegisteredTenant> {
  const email = `${randomUUID()}@e2e.test`;

  const registered = await request(app.getHttpServer())
    .post('/auth/register')
    .send({
      email,
      password: TEST_PASSWORD,
      firstName: 'Test',
      lastName: 'Usuario',
      businessName,
    })
    .expect(201);

  const { accessToken, refreshToken } = registered.body as {
    accessToken: string;
    refreshToken: string;
  };

  const me = await request(app.getHttpServer())
    .get('/auth/me')
    .set('Authorization', `Bearer ${accessToken}`)
    .expect(200);

  const body = me.body as {
    user: { id: string };
    tenant: { id: string };
    employee: { id: string };
  };

  return {
    email,
    password: TEST_PASSWORD,
    accessToken,
    refreshToken,
    tenantId: body.tenant.id,
    userId: body.user.id,
    employeeId: body.employee.id,
    businessName,
  };
}

/**
 * Cambia el plan del negocio. El registro siempre entrega el plan "básico"
 * (1 sucursal, 1 empleado: solo el dueño), así que casi todo lo que tenga que
 * ver con equipos o varias sucursales necesita mover el plan primero.
 */
export async function switchPlan(
  prisma: PrismaService,
  tenantId: string,
  slug: string,
): Promise<void> {
  const plan = await prisma.plan.findUnique({ where: { slug } });

  if (!plan) {
    throw new Error(`El seed no tiene el plan "${slug}"`);
  }

  await prisma.tenant.update({
    where: { id: tenantId },
    data: { planId: plan.id },
  });
}

/** Azúcar para no repetir el header en cada request. */
export const auth = (token: string): [string, string] => [
  'Authorization',
  `Bearer ${token}`,
];
