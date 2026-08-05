import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient, SupportLevel } from '@prisma/client';

/**
 * Seed del catálogo global de planes.
 *
 * Es idempotente: hace `upsert` por `slug`, así que se puede correr las veces
 * que haga falta. El seed es la FUENTE DE VERDAD del catálogo — si cambiás un
 * precio o un límite acá y volvés a correrlo, la fila se actualiza.
 *
 * Uso: `npx prisma db seed` (el comando está configurado en prisma.config.ts).
 *
 * Nota: usa el PrismaClient base, sin las extensions de soft-delete/tenant-scope.
 * `Plan` está exento de ambas, así que no hay contexto de tenant que montar.
 */

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL no está definida — revisá tu archivo .env');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

/** Los precios se guardan en cents (Int), nunca en Decimal/Float. */
const pesosToCents = (pesos: number): number => pesos * 100;

/**
 * Precios finales en ARS (IVA incluido). El plan anual equivale a 11 meses.
 * `maxEmployees` incluye al owner. `null` = a medida / sin límite (plan Empresa,
 * que se cotiza contactando a soporte).
 */
const PLANS: Prisma.PlanCreateInput[] = [
  {
    name: 'Básico',
    slug: 'basico',
    priceMonthlyCents: pesosToCents(25_000),
    priceYearlyCents: pesosToCents(275_000),
    maxEmployees: 1,
    maxBranches: 1,
    includesClinicRecords: true,
    includesResources: false,
    supportLevel: SupportLevel.STANDARD,
    isActive: true,
    displayOrder: 1,
  },
  {
    name: 'Pro',
    slug: 'pro',
    priceMonthlyCents: pesosToCents(45_000),
    priceYearlyCents: pesosToCents(495_000),
    maxEmployees: 4,
    maxBranches: 1,
    includesClinicRecords: true,
    includesResources: true,
    supportLevel: SupportLevel.PRIORITY,
    isActive: true,
    displayOrder: 2,
  },
  {
    name: 'Avanzado',
    slug: 'avanzado',
    priceMonthlyCents: pesosToCents(80_000),
    priceYearlyCents: pesosToCents(880_000),
    maxEmployees: 7,
    maxBranches: 2,
    includesClinicRecords: true,
    includesResources: true,
    supportLevel: SupportLevel.PRIORITY,
    isActive: true,
    displayOrder: 3,
  },
  {
    name: 'Empresa',
    slug: 'empresa',
    priceMonthlyCents: null,
    priceYearlyCents: null,
    maxEmployees: null,
    maxBranches: null,
    includesClinicRecords: true,
    includesResources: true,
    supportLevel: SupportLevel.PRIORITY,
    isActive: true,
    displayOrder: 4,
  },
];

async function seedPlans(): Promise<void> {
  await prisma.$transaction(async (tx) => {
    for (const plan of PLANS) {
      await tx.plan.upsert({
        where: { slug: plan.slug },
        create: plan,
        update: plan,
      });
      console.log(`  ✔ plan "${plan.slug}"`);
    }
  });
}

async function main(): Promise<void> {
  console.log('🌱 Seeding...');
  await seedPlans();
  console.log(`✅ Listo: ${PLANS.length} planes sincronizados.`);
}

main()
  .catch((error: unknown) => {
    console.error('❌ El seed falló:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
