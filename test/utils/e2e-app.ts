import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ThrottlerGuard } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

/** La app tipada con el server de supertest: sin esto `getHttpServer()` es `any`. */
export type TestApp = INestApplication<App>;

export interface E2EContext {
  app: TestApp;
  prisma: PrismaService;
}

/** Contraseña válida según las reglas del DTO (8+, con letra y número). */
export const TEST_PASSWORD = 'Password123!';

/**
 * Levanta la app real: mismos módulos, mismo `ValidationPipe`, mismo filtro de
 * excepciones y los mismos guards globales que en producción (por eso el pipe y
 * el filtro se registran en `AppModule` y no en `main.ts`).
 *
 * Lo único que se desactiva es el rate limiting: los tests hacen decenas de
 * registros y logins por minuto y el límite real es de 5. Que el throttler
 * funcione se prueba aparte (Fase 9), no acá.
 */
export async function createTestApp(): Promise<E2EContext> {
  jest.spyOn(ThrottlerGuard.prototype, 'canActivate').mockResolvedValue(true);

  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleRef.createNestApplication<TestApp>({ logger: false });
  await app.init();

  return { app, prisma: app.get(PrismaService) };
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
