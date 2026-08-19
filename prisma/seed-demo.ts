import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { EmployeeRole, PrismaClient, SubscriptionStatus } from '@prisma/client';
import * as argon2 from 'argon2';
import { normalizePhone } from '../src/common/utils/phone.util';

/**
 * Datos de demo para desarrollar el frontend sin tener que crear todo a mano.
 *
 * Deja un negocio con dos sucursales, horarios cargados, un feriado y tres
 * empleados: el dueño, una profesional que ya activó su cuenta, y una invitada
 * que todavía NO la activó — para poder probar la pantalla de activación con un
 * link de verdad, que se imprime al final.
 *
 * Uso: `npm run seed:demo`
 *
 * **Solo para desarrollo.** Borra y vuelve a crear el negocio de demo cada vez
 * que corre, así siempre arranca del mismo estado conocido. No toca ningún otro
 * negocio de la base, ni los planes.
 *
 * Usa el PrismaClient base (sin extensions): no hay request ni contexto de
 * tenant, así que el `tenantId` va explícito en cada insert.
 */

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  throw new Error('DATABASE_URL no está definida — revisá tu archivo .env');
}

if (process.env.NODE_ENV === 'production') {
  throw new Error('El seed de demo no se corre en producción.');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

const DEMO = {
  businessName: 'Peluquería Demo',
  slug: 'peluqueria-demo',
  /** Todas las cuentas de demo usan la misma contraseña. */
  password: 'demo1234',
  owner: {
    email: 'dueno@demo.test',
    firstName: 'Ana',
    lastName: 'Gómez',
  },
  active: {
    email: 'profesional@demo.test',
    firstName: 'Lucía',
    lastName: 'Fernández',
  },
  pending: {
    email: 'invitada@demo.test',
    firstName: 'Mora',
    lastName: 'Silva',
  },
} as const;

/** La plata se guarda en centavos, nunca en decimales. */
const pesosToCents = (pesos: number): number => pesos * 100;

/** `"09:00"` → el `Date` anclado al epoch que espera una columna TIME. */
const time = (value: string): Date => new Date(`1970-01-01T${value}:00.000Z`);

/** `"2026-12-25"` → el `Date` a medianoche UTC que espera una columna DATE. */
const date = (value: string): Date => new Date(`${value}T00:00:00.000Z`);

/** Lunes a viernes 09:00–18:00, sábado hasta las 14:00, domingo cerrado. */
function weekFor(tenantId: string, branchId: string) {
  return Array.from({ length: 7 }, (_, dayOfWeek) => {
    const closed = dayOfWeek === 0;
    const saturday = dayOfWeek === 6;

    return {
      tenantId,
      branchId,
      dayOfWeek,
      isClosed: closed,
      opensAt: closed ? null : time('09:00'),
      closesAt: closed ? null : time(saturday ? '14:00' : '18:00'),
    };
  });
}

/** Borra el negocio de demo si quedó de una corrida anterior. */
async function resetDemo(): Promise<void> {
  const existing = await prisma.tenant.findUnique({
    where: { slug: DEMO.slug },
    select: { id: true },
  });

  if (!existing) {
    return;
  }

  // Las tablas hijas caen por CASCADE; los `users` no, porque el FK de
  // `employees` es RESTRICT y además la cuenta es de la persona, no del negocio.
  await prisma.tenant.delete({ where: { id: existing.id } });
  await prisma.user.deleteMany({
    where: {
      email: { in: [DEMO.owner.email, DEMO.active.email, DEMO.pending.email] },
    },
  });

  console.log('  ✔ negocio de demo anterior borrado');
}

async function main(): Promise<void> {
  console.log('🌱 Seed de demo...');

  await resetDemo();

  const plan = await prisma.plan.findUnique({ where: { slug: 'avanzado' } });

  if (!plan) {
    throw new Error(
      'Falta el catálogo de planes: corré `npx prisma db seed` primero.',
    );
  }

  const passwordHash = await argon2.hash(DEMO.password, {
    type: argon2.argon2id,
  });

  const { tenantId, pendingEmployeeId } = await prisma.$transaction(
    async (tx) => {
      // ── Negocio y dueño ──────────────────────────────────────────────
      const owner = await tx.user.create({
        data: { ...DEMO.owner, passwordHash },
        select: { id: true },
      });

      const tenant = await tx.tenant.create({
        data: {
          ownerUserId: owner.id,
          planId: plan.id,
          businessName: DEMO.businessName,
          slug: DEMO.slug,
          subscriptionStatus: SubscriptionStatus.TRIAL,
          trialEndsAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
          branding: { create: { displayName: DEMO.businessName } },
          settings: { create: {} },
        },
        select: { id: true },
      });

      await tx.employee.create({
        data: {
          tenantId: tenant.id,
          userId: owner.id,
          role: EmployeeRole.OWNER,
          isOwner: true,
        },
      });

      // ── Sucursales con su horario ────────────────────────────────────
      const centro = await tx.branch.create({
        data: {
          tenantId: tenant.id,
          name: 'Sucursal Centro',
          address: 'Av. Corrientes 1234',
          phone: '+54 11 5555-1111',
        },
        select: { id: true },
      });

      const palermo = await tx.branch.create({
        data: {
          tenantId: tenant.id,
          name: 'Sucursal Palermo',
          address: 'Gorriti 4567',
        },
        select: { id: true },
      });

      await tx.branchBusinessHour.createMany({
        data: [
          ...weekFor(tenant.id, centro.id),
          ...weekFor(tenant.id, palermo.id),
        ],
      });

      await tx.branchSpecialDay.create({
        data: {
          tenantId: tenant.id,
          branchId: centro.id,
          date: date('2026-12-25'),
          isClosed: true,
          description: 'Navidad',
        },
      });

      // ── Empleada activa, con turno partido en las dos sucursales ─────
      const activeUser = await tx.user.create({
        data: { ...DEMO.active, passwordHash },
        select: { id: true },
      });

      const active = await tx.employee.create({
        data: {
          tenantId: tenant.id,
          userId: activeUser.id,
          role: EmployeeRole.PROFESSIONAL,
          hiredAt: date('2025-03-01'),
          bio: 'Colorista. Diez años de experiencia.',
        },
        select: { id: true },
      });

      await tx.employeeBranch.createMany({
        data: [
          { tenantId: tenant.id, employeeId: active.id, branchId: centro.id },
          { tenantId: tenant.id, employeeId: active.id, branchId: palermo.id },
        ],
      });

      await tx.employeeSchedule.createMany({
        data: [
          // Lunes y miércoles en Centro, con corte al mediodía.
          ...[1, 3].flatMap((dayOfWeek) => [
            {
              tenantId: tenant.id,
              employeeId: active.id,
              branchId: centro.id,
              dayOfWeek,
              startsAt: time('09:00'),
              endsAt: time('13:00'),
            },
            {
              tenantId: tenant.id,
              employeeId: active.id,
              branchId: centro.id,
              dayOfWeek,
              startsAt: time('16:00'),
              endsAt: time('20:00'),
            },
          ]),
          // Martes y jueves en Palermo, corrido.
          ...[2, 4].map((dayOfWeek) => ({
            tenantId: tenant.id,
            employeeId: active.id,
            branchId: palermo.id,
            dayOfWeek,
            startsAt: time('10:00'),
            endsAt: time('18:00'),
          })),
        ],
      });

      await tx.employeeTimeOff.create({
        data: {
          tenantId: tenant.id,
          employeeId: active.id,
          branchId: null,
          startsAt: new Date('2026-09-07T03:00:00.000Z'),
          endsAt: new Date('2026-09-21T03:00:00.000Z'),
          reason: 'Vacaciones',
        },
      });

      // ── Empleada invitada: existe, pero todavía no puede entrar ──────
      const pendingUser = await tx.user.create({
        data: { ...DEMO.pending, passwordHash: null },
        select: { id: true },
      });

      const pending = await tx.employee.create({
        data: {
          tenantId: tenant.id,
          userId: pendingUser.id,
          role: EmployeeRole.ADMINISTRATIVE,
        },
        select: { id: true },
      });

      await tx.employeeBranch.create({
        data: { tenantId: tenant.id, employeeId: pending.id, branchId: centro.id },
      });

      // ── Catálogo: categorías, servicios y quién los presta ───────────
      const [corteCat, colorCat] = await Promise.all([
        tx.serviceCategory.create({
          data: { tenantId: tenant.id, name: 'Corte', displayOrder: 1 },
          select: { id: true },
        }),
        tx.serviceCategory.create({
          data: { tenantId: tenant.id, name: 'Color', displayOrder: 2 },
          select: { id: true },
        }),
      ]);

      const corte = await tx.service.create({
        data: {
          tenantId: tenant.id,
          categoryId: corteCat.id,
          name: 'Corte de dama',
          description: 'Lavado, corte y peinado.',
          durationMinutes: 45,
          priceCents: pesosToCents(15_000),
          bufferAfterMinutes: 10,
          color: '#7C3AED',
        },
        select: { id: true },
      });

      const coloracion = await tx.service.create({
        data: {
          tenantId: tenant.id,
          categoryId: colorCat.id,
          name: 'Coloración completa',
          description: 'Color de raíz a puntas. Incluye lavado.',
          durationMinutes: 120,
          priceCents: pesosToCents(45_000),
          depositAmountCents: pesosToCents(15_000),
          bufferAfterMinutes: 15,
          color: '#DB2777',
        },
        select: { id: true },
      });

      // Lucía hace corte en las dos sucursales, pero color solo en Centro:
      // el front necesita ese caso para no asumir "un servicio, todos lados".
      await tx.employeeService.createMany({
        data: [
          {
            tenantId: tenant.id,
            employeeId: active.id,
            serviceId: corte.id,
            branchId: centro.id,
          },
          {
            tenantId: tenant.id,
            employeeId: active.id,
            serviceId: corte.id,
            branchId: palermo.id,
          },
          {
            tenantId: tenant.id,
            employeeId: active.id,
            serviceId: coloracion.id,
            branchId: centro.id,
          },
        ],
      });

      // ── Recursos: la coloración ocupa la sala, el corte no ───────────
      const salaColor = await tx.resource.create({
        data: {
          tenantId: tenant.id,
          branchId: centro.id,
          name: 'Sala de color',
          description: 'Única sala con lavabo reclinable.',
        },
        select: { id: true },
      });

      await tx.resource.create({
        data: {
          tenantId: tenant.id,
          branchId: palermo.id,
          name: 'Sillón 1',
        },
      });

      await tx.serviceResource.create({
        data: {
          tenantId: tenant.id,
          serviceId: coloracion.id,
          resourceId: salaColor.id,
        },
      });

      // ── Clientes ──────────────────────────────────────────────────────
      // Los teléfonos van escritos de tres formas distintas a propósito: es lo
      // que pasa en la vida real y lo que el front tiene que poder buscar.
      // `phoneNormalized` es lo que compara la base; acá se calcula a mano
      // porque el seed no pasa por el service.
      const vip = await tx.customerTag.create({
        data: { tenantId: tenant.id, name: 'VIP', color: '#7C3AED' },
        select: { id: true },
      });

      await tx.customerTag.create({
        data: { tenantId: tenant.id, name: 'Debe seña', color: '#DB2777' },
      });

      const clientas = await Promise.all(
        [
          {
            firstName: 'Sofía',
            lastName: 'Ramírez',
            phone: '+54 9 11 4123-5566',
            email: 'sofia.ramirez@demo.test',
            dateOfBirth: new Date('1988-03-14T00:00:00.000Z'),
            notes: 'Viene siempre con su hija. Prefiere turnos temprano.',
          },
          {
            firstName: 'Julieta',
            lastName: 'Moreno',
            phone: '(011) 4777-8899',
            email: null,
            dateOfBirth: null,
            notes: null,
          },
          {
            firstName: 'Carolina',
            lastName: 'Duarte',
            phone: '11 5030-2211',
            email: 'caro.duarte@demo.test',
            dateOfBirth: new Date('1995-11-02T00:00:00.000Z'),
            notes: 'Alérgica al amoníaco: usar línea sin amoníaco.',
          },
        ].map((data) =>
          tx.customer.create({
            data: {
              ...data,
              tenantId: tenant.id,
              phoneNormalized: normalizePhone(data.phone),
            },
            select: { id: true },
          }),
        ),
      );

      await tx.customerTagAssignment.create({
        data: {
          tenantId: tenant.id,
          customerId: clientas[0].id,
          tagId: vip.id,
        },
      });

      return { tenantId: tenant.id, pendingEmployeeId: pending.id };
    },
  );

  // ── Invitación de la empleada pendiente ────────────────────────────────
  // Va fuera de la transacción a propósito: el secreto se genera acá para poder
  // imprimirlo, y en la base queda solo su hash.
  const secret = randomBytes(32).toString('base64url');
  const invitation = await prisma.employeeInvitation.create({
    data: {
      tenantId,
      employeeId: pendingEmployeeId,
      tokenHash: await argon2.hash(secret, { type: argon2.argon2id }),
      expiresAt: new Date(Date.now() + 72 * 60 * 60 * 1000),
    },
    select: { id: true },
  });

  const appBaseUrl = process.env.APP_BASE_URL ?? 'http://localhost:3000';
  const activationUrl = `${appBaseUrl.replace(/\/+$/, '')}/activar?token=${encodeURIComponent(
    `${invitation.id}.${secret}`,
  )}`;

  console.log(`
✅ Negocio de demo listo: "${DEMO.businessName}"

   Contraseña de todas las cuentas: ${DEMO.password}

   ${DEMO.owner.email.padEnd(24)} dueño (OWNER)
   ${DEMO.active.email.padEnd(24)} profesional, cuenta activa
   ${DEMO.pending.email.padEnd(24)} administrativa, INVITADA (no puede entrar todavía)

   2 sucursales con horario cargado · 1 feriado · turno partido · 1 ausencia
   2 categorías · 2 servicios · 2 recursos · 1 servicio que requiere sala
   3 clientas (teléfonos escritos de tres formas) · 2 etiquetas · 1 VIP

   Link para probar la pantalla de activación:
   ${activationUrl}
`);
}

main()
  .catch((error: unknown) => {
    console.error('❌ El seed de demo falló:', error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
