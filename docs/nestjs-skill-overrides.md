# Overrides de la skill `nestjs-best-practices`

La skill instalada (`.claude/skills/nestjs-best-practices`, autor Kadajett, MIT) es una
buena guía **general** de NestJS, pero sus ejemplos asumen **TypeORM + `@nestjs/config` + Joi**.
Este repo usa **Prisma 7 (driver adapter `@prisma/adapter-pg`) + Zod**, con una capa de datos
opinada (`prisma.scoped`, extensiones de soft-delete y tenant-scope, `TenantContextService`
sobre `AsyncLocalStorage`).

Este documento traduce/corrige las reglas de la skill que **no aplican tal cual** a nuestro stack.

## Precedencia

Cuando la skill y este repo estén en desacuerdo:

```
CLAUDE.md  >  docs/nestjs-skill-overrides.md (este archivo)  >  skill nestjs-best-practices
```

La skill es referencia; no reemplaza las convenciones del repo.

## Qué usar de la skill y qué no

| Sección de la skill | Veredicto | Nota |
|---|---|---|
| `arch-*` (feature modules, single-responsibility, circular deps, events) | ✅ Usar tal cual | Coincide con `src/modules/<feature>/` |
| `di-*` (injection tokens, scopes, constructor injection) | ✅ Usar tal cual | `di-scope-awareness` recomienda `nestjs-cls` para request context → mismo concepto que nuestro `TenantContextService`/`AsyncLocalStorage` |
| `error-*` (exception filters, HTTP exceptions, async errors) | ✅ Usar tal cual | Ya tenemos `AllExceptionsFilter` |
| `security-*` (JWT, guards, validación, rate-limit, sanitize) | ✅ Usar tal cual | `security-auth-jwt` es sólido (access corto + refresh hasheado) |
| `api-*` (DTO/serialization, interceptors, pipes, versioning) | ✅ Usar tal cual | class-validator + `ValidationPipe` ya montados |
| `test-*` | ✅ Usar tal cual | Jest + `Test.createTestingModule` |
| `devops-*` (logging, graceful shutdown) | ✅ Usar tal cual | Pino ya montado |
| `devops-use-config-module` | ⚠️ **Traducir** | Usa Joi + `@nestjs/config`; nosotros usamos **Zod** → ver abajo |
| `db-use-transactions` | ⚠️ **Traducir** | TypeORM `DataSource.transaction` → **`prisma.scoped.$transaction`** |
| `db-avoid-n-plus-one` | ⚠️ **Traducir** | `relations`/`createQueryBuilder` → **`include`/`select`** de Prisma |
| `db-use-migrations` | ⚠️ **Traducir** | TypeORM migrations → **`npx prisma migrate dev --name <name>`** (ver CLAUDE.md) |
| `arch-use-repository-pattern` | ⚠️ **No recrear la capa TypeORM** | Ver abajo: usamos `prisma.scoped` directo |

---

## Overrides Prisma-native

### 1. Transacciones (`db-use-transactions`)

Nada de `DataSource.transaction` / `QueryRunner`. Usar `$transaction` **sobre el cliente
extendido** (`prisma.scoped`) para que las extensiones de tenant-scope y soft-delete se sigan
aplicando dentro de la transacción.

```typescript
@Injectable()
export class AppointmentsService {
  constructor(private readonly prisma: PrismaService) {}

  // Transacción interactiva: el `tx` deriva de `prisma.scoped`,
  // así que sigue inyectando tenantId y respetando soft-delete.
  // El callback corre dentro del mismo contexto async, por lo que
  // TenantContextService.getStore() sigue resolviendo el tenant.
  async book(dto: CreateAppointmentDto) {
    return this.prisma.scoped.$transaction(async (tx) => {
      const appointment = await tx.appointment.create({
        data: { customerId: dto.customerId, startsAt: dto.startsAt },
        // tenantId lo inyecta la extension — no lo pasamos a mano
      });

      await tx.appointmentService.createMany({
        data: dto.serviceIds.map((serviceId) => ({
          appointmentId: appointment.id,
          serviceId,
        })),
      });

      // Si esto lanza, rollback de todo.
      return appointment;
    });
  }
}
```

Forma secuencial (array) también sobre el cliente extendido:

```typescript
await this.prisma.scoped.$transaction([
  this.prisma.scoped.appointment.update({ where: { id }, data: { status: 'confirmed' } }),
  this.prisma.scoped.auditLog.create({ data: { action: 'confirm', appointmentId: id } }),
]);
```

**Gotchas:**
- No arrancar la transacción fuera de `TenantContextService.run(...)`; si no hay contexto
  montado sobre un modelo no exento, la extension lanza `TenantContextMissingError` (500).
- Para jobs/seeds usar `runWithoutTenant(...)` alrededor de la transacción (passthrough).
- El cliente base (`prisma.$transaction`, sin `.scoped`) **no** scopea por tenant: reservarlo
  para auth pre-login, health y seeds.

### 2. N+1 (`db-avoid-n-plus-one`)

Prisma resuelve relaciones con `include`/`select` (queries batcheadas), no con `relations`
de TypeORM ni `createQueryBuilder`.

```typescript
// ❌ N+1: una query por cita para traer sus servicios
const appointments = await this.prisma.scoped.appointment.findMany({ where: { branchId } });
for (const appt of appointments) {
  appt.services = await this.prisma.scoped.appointmentService.findMany({
    where: { appointmentId: appt.id },
  });
}

// ✅ Una sola pasada con include (Prisma batchea la relación)
const appointments = await this.prisma.scoped.appointment.findMany({
  where: { branchId },
  include: {
    services: { include: { service: true } },
    customer: { select: { id: true, firstName: true } },
  },
});

// ✅ Conteos sin traer filas: usar _count
const withCounts = await this.prisma.scoped.customer.findMany({
  select: { id: true, firstName: true, _count: { select: { appointments: true } } },
});
```

**Recordatorio de tenant:** `findUnique`/`findUniqueOrThrow` **no** están interceptados por las
extensiones (limitación de `WhereUniqueInput`). Para respetar tenant/soft-delete sobre una
unique key, usar **`findFirst`**. (Ya documentado en CLAUDE.md.)

### 3. Repository pattern (`arch-use-repository-pattern`)

La skill propone una capa de repositorios estilo `@InjectRepository(User) repo: Repository<User>`.
**No recrear eso.** Nuestra "capa de repositorio" ya es `prisma.scoped`, que centraliza
soft-delete + tenant-scope. Inyectar `PrismaService` directamente en el service:

```typescript
@Injectable()
export class CustomersService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.scoped.customer.findMany(); // ya filtra tenant + no-borrados
  }
}
```

Si una query se vuelve compleja, mantenerla en el service o extraerla a un método/helper
privado del mismo módulo. No hace falta `PrismaModule` (es `@Global`).

### 4. Config con Zod (`devops-use-config-module`)

La skill usa `@nestjs/config` + **Joi** + `registerAs`. **No** introducir eso. Este repo valida
env con **Zod** y lo cablea vía `validate`:

```typescript
// src/config/env.schema.ts — extender el schema Zod
export const envSchema = z.object({
  // ...existentes
  JWT_SECRET: z.string().min(32),
});
export type Env = z.infer<typeof envSchema>;

// src/app.module.ts
ConfigModule.forRoot({ isGlobal: true, validate: validateEnv });

// Acceso tipado en cualquier provider
constructor(private readonly config: ConfigService<Env, true>) {}
const secret = this.config.get('JWT_SECRET', { infer: true });
```

Al agregar una variable: extender `envSchema`, sumarla a `.env.example`, y leerla con
`.get('KEY', { infer: true })`. (Ya documentado en CLAUDE.md.)

### 5. Migraciones (`db-use-migrations`)

TypeORM migrations no aplican. Flujo Prisma:

```bash
npx prisma migrate dev --name <descriptive_name>   # crea SQL + regenera cliente
npx prisma generate                                # regenerar cliente tras cambios de schema
```
