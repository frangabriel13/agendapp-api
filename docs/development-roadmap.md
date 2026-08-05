# 🛣️ Roadmap de Desarrollo — AgendApp API

> Guía paso a paso para construir el backend de AgendApp desde el esqueleto actual hasta producción.
> **Leerlo a medida que avanzás.** Cada fase asume completada la anterior.
> Complementario a [`database-reference.md`](./database-reference.md), que es la referencia del modelo de datos.

---

## 📌 Estado actual del repo

> **Fase 0 cerrada.** Los cimientos transversales están completos; el próximo paso es la Fase 1.

- ✅ NestJS 11 + TypeScript `strict` + Prisma 7 (driver adapter `@prisma/adapter-pg`).
- ✅ `ConfigModule` con validación Zod (`src/config/env.schema.ts`).
- ✅ `PrismaService` global con dos clientes: `prisma.<modelo>` (base) y `prisma.scoped.<modelo>` (extendido).
- ✅ Healthcheck `GET /health` con `PrismaHealthIndicator`.
- ✅ Docker Compose con Postgres 16 + Adminer.
- ✅ `TenantContextService` sobre `AsyncLocalStorage` (`run` / `runWithoutTenant`), global.
- ✅ Extensions de Prisma: soft delete + tenant scope (`src/prisma/extensions/`), con modelos exentos explícitos.
- ✅ Logger estructurado (nestjs-pino + `requestId`), filtro global de excepciones, Swagger en `/api`, `ValidationPipe` global y `ThrottlerModule` con guard global.
- ✅ Migración `20260515120000_enable_extensions` (`pgcrypto` para `gen_random_uuid()`, `btree_gist` para la Fase 5).
- ⚠️ Schema con **0 modelos** de negocio: los dominios reales empiezan en la Fase 1.
- ⚠️ Hueco consciente: el middleware que llena el tenant-context desde el JWT se implementa en la Fase 1 (1.4/1.5). Hasta entonces, cualquier query sobre `prisma.scoped` fuera de `runWithoutTenant` lanza `TenantContextMissingError`.
- ❌ Sin auth, sin RLS (Fase 8), sin dominios reales.

---

## 🧭 Mapa general de fases

| Fase | Tema | Objetivo |
|---|---|---|
| ✅ 0 | Cimientos transversales | Decisiones base (IDs, soft delete, tenant scoping, logging, swagger) |
| 1 | Auth + Tenant base | Registro, login, JWT, planes, suscripción |
| 2 | Estructura del negocio | Sucursales y empleados |
| 3 | Catálogo | Servicios, categorías, recursos |
| 4 | Clientes | Customers + tags |
| 5 | Turnos (corazón) | Appointments + disponibilidad + recurrencia |
| 6 | Pagos | Mercado Pago (señas + suscripciones) |
| 7 | Portal público | Endpoints sin auth para reservar online |
| 8 | Transversales finales | Notas, auditoría, RLS, jobs (BullMQ) |
| 9 | Hardening | E2E, observabilidad, métricas, carga |

**Heurística clave:** la Fase 5 (turnos) es la más delicada. Todo lo anterior existe para que esa fase se construya sobre datos sanos. **No te adelantes a turnos** sin tener empleados, servicios y horarios firmes.

---

## 🏗️ FASE 0 — Cimientos transversales

> Hacelo **antes** de tocar el primer dominio. Si lo dejás para después, vas a re-escribir 10 services.

### 0.1 Decidir IDs (UUID v4)

La referencia dice UUID v4. El `Tenant` actual usa `cuid()`. Unificar:

```prisma
model Tenant {
  id String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  // ...
}
```

- Habilitar la extensión `pgcrypto` en una migración SQL: `CREATE EXTENSION IF NOT EXISTS pgcrypto;`
- Actualizar `database-reference.md` para reflejar la decisión.
- Como solo existe el `Tenant` placeholder, podés hacer `prisma migrate reset` sin culpa.

### 0.2 Convenciones de schema

Aplicar consistentemente desde el primer modelo nuevo:

- Modelos en **PascalCase singular** (`User`, `Appointment`).
- Campos en **camelCase** (`firstName`, `tenantId`).
- `@map("snake_case")` por campo y `@@map("snake_case")` por modelo.
- Todas las tablas de negocio: `tenantId`, `createdAt`, `updatedAt`, `deletedAt`.
- Plata: `Int` en cents. **Nunca** `Decimal` ni `Float`.
- Fechas: `DateTime @db.Timestamptz` (UTC).

### 0.3 Tenant scoping con AsyncLocalStorage

Crear `src/common/tenant-context/`:

- `TenantContextService` que envuelve un `AsyncLocalStorage<{ tenantId: string; userId: string }>`.
- `TenantContextMiddleware` que extrae `tenantId` del JWT y lo guarda en el ALS.
- Registrar el middleware globalmente en `AppModule`.

### 0.4 Prisma Client Extension (soft delete + tenant scope)

En `src/prisma/extensions/`:

- **Soft delete:** interceptar `delete`/`deleteMany` → convertir en `update`/`updateMany` con `deletedAt: new Date()`. En `find*` agregar `where: { deletedAt: null, ...args.where }`.
- **Tenant scope:** en todas las queries sobre tablas con `tenantId`, inyectar `where: { tenantId: ctx.tenantId }` automáticamente.
- Modelos exentos (`User`, `Plan`, `RefreshToken`, `AuditLog` con tenant nullable) listados explícitamente.

Aplicar la extension dentro de `PrismaService.onModuleInit`:

```ts
this.$extends(softDeleteExtension).$extends(tenantScopeExtension(tenantContext))
```

### 0.5 Logger estructurado

```bash
npm i nestjs-pino pino-http
npm i -D pino-pretty
```

Configurar `LoggerModule.forRoot` con `pino-pretty` en dev y JSON en prod. Reemplazar el logger de Nest.

### 0.6 Filtro global de excepciones

`src/common/filters/all-exceptions.filter.ts`:

- Mapear `Prisma.PrismaClientKnownRequestError` (P2002 → 409, P2025 → 404).
- Formato uniforme: `{ statusCode, message, error, path, timestamp, requestId }`.
- Loguear con `pino` (request id incluido).

### 0.7 Swagger en `/api`

```bash
npm i @nestjs/swagger
```

`main.ts`: setup con `DocumentBuilder`, bearer auth, tags por módulo. Todos los DTOs anotados con `@ApiProperty`.

### 0.8 Validación global

`main.ts`:

```ts
app.useGlobalPipes(new ValidationPipe({
  whitelist: true,
  forbidNonWhitelisted: true,
  transform: true,
}));
```

### 0.9 Throttling

```bash
npm i @nestjs/throttler
```

`ThrottlerModule` global. Más restrictivo en endpoints públicos (Fase 7).

**✅ Done cuando:** `npm run start:dev` levanta, `/health` responde, Swagger sirve en `/api`, los logs salen estructurados, y existe el `TenantContextService` aunque no haya nada que lo use todavía.

---

## 🔐 FASE 1 — Auth y Tenant base

### 1.1 Migración: auth + tenant

Crear modelos Prisma en este orden (sin las FKs circulares aún):

1. `User` — sin relación a `Tenant` todavía.
2. `RefreshToken` — FK a `User`.
3. `Plan` — sin FKs.
4. `Tenant` — refactor del actual: agregar `ownerUserId`, `planId`, `slug`, `subscriptionStatus`, `trialEndsAt`, `timezone`, `currency`, `language`.
5. `Subscription` — FK a `Tenant` y `Plan`.

```bash
npx prisma migrate dev --name auth_and_tenant_base
```

### 1.2 Seeds de planes

`prisma/seed.ts` con los 4 planes (Básico, Pro, Avanzado, Business). Configurar `package.json`:

```json
"prisma": { "seed": "ts-node prisma/seed.ts" }
```

Correr: `npx prisma db seed`.

### 1.3 AuthModule

```bash
npx nest g module modules/auth
npx nest g service modules/auth
npx nest g controller modules/auth
npm i @nestjs/jwt @nestjs/passport passport passport-jwt argon2
npm i -D @types/passport-jwt
```

Endpoints:

- `POST /auth/register` — crea `User` + `Tenant` + `Employee` (owner) + `Subscription` (trial) **en una transacción** (`prisma.$transaction`).
- `POST /auth/login` — devuelve `{ accessToken, refreshToken }`. Refresh hash con argon2 en `refresh_tokens`.
- `POST /auth/refresh` — rotación de refresh token (revoca el viejo, emite uno nuevo).
- `POST /auth/logout` — revoca el refresh token actual.
- `GET /auth/me` — devuelve user + tenant + role.

### 1.4 Guard global

`JwtAuthGuard` aplicado con `APP_GUARD` en `AppModule`. Decorator `@Public()` para opt-out (lo van a usar Fase 7 y `/health`).

El payload del JWT debe incluir: `userId`, `tenantId`, `employeeId`, `role`. El middleware de Fase 0.3 los empuja al ALS.

### 1.5 TenantsModule

```bash
npx nest g resource modules/tenants
```

- `GET /tenants/me` — info del tenant del usuario logueado.
- `PATCH /tenants/me` — editar `businessName`, `timezone`, etc.
- `tenant_branding` y `tenant_settings` como sub-recursos: `GET/PATCH /tenants/me/branding`, `GET/PATCH /tenants/me/settings`.

**✅ Done cuando:** podés registrarte, recibir un token, llamar a `/auth/me` y ver tu tenant. Tests E2E del flujo completo.

### ⏭️ Diferido — Emails transaccionales

**Deadline: antes de la Fase 7 (portal público)**, no en la Fase 8. Lo único que
bloquea esto es tener un proveedor de mail (Resend / SendGrid / SES) y un dominio
con SPF/DKIM. **No** depende de BullMQ: la cola solo aporta reintentos y no
bloquear la respuesta.

- `POST /auth/forgot-password` + `POST /auth/reset-password` (tabla nueva `password_reset_tokens`).
- `POST /auth/verify-email` + reenvío (el campo `users.email_verified_at` ya existe desde la Fase 1).

Posponerlo no genera deuda: no toca nada de lo construido en la Fase 1, solo suma
una tabla y endpoints. El riesgo real es el **reset de contraseña** — hasta que
exista, a un usuario que olvida la clave hay que cambiársela a mano en la base.

---

## 🏬 FASE 2 — Estructura del negocio

### 2.1 Sucursales

Migración: `Branch`, `BranchBusinessHours`, `BranchSpecialDay`.

```bash
npx prisma migrate dev --name branches
npx nest g resource modules/branches
```

Reglas:

- Al crear una `Branch`, validar `tenant.plan.maxBranches` contra el count actual.
- `BranchBusinessHours`: 7 filas por sucursal (una por día). `is_closed` para días sin atención.
- Constraint: `CHECK (closes_at > opens_at OR is_closed = true)`.

### 2.2 Empleados

Migración: `Employee`, `EmployeeBranch`, `EmployeeSchedule`, `EmployeeTimeOff`.

```bash
npx prisma migrate dev --name employees
npx nest g resource modules/employees
```

Endpoints clave:

- `POST /employees` — invitación: crea `User` (sin password), envía email con link de activación, crea `Employee`.
- `POST /employees/:id/activate` (público) — recibe token + password.
- `PUT /employees/:id/branches` — asignar/desasignar sucursales.
- `PUT /employees/:id/schedules` — set semanal (7 días × N sucursales).
- `POST /employees/:id/time-off` — vacaciones / ausencias.

Validar `maxEmployees` del plan al crear (incluye al owner — chequear `is_owner`).

**✅ Done cuando:** se puede crear una sucursal con horarios, invitar un empleado, asignarle sucursales y un horario semanal distinto por sucursal.

---

## ✂️ FASE 3 — Catálogo (Servicios y Recursos)

### 3.1 Servicios

Migración: `ServiceCategory`, `Service`, `EmployeeService`.

```bash
npx prisma migrate dev --name services
npx nest g resource modules/services
npx nest g resource modules/service-categories
```

Endpoints:

- CRUD de `ServiceCategory` y `Service`.
- `PUT /services/:id/employees` — define qué empleados pueden prestar el servicio y en qué sucursales (`EmployeeService` con `branch_id`).

### 3.2 Recursos

Migración: `Resource`, `ServiceResource`.

```bash
npx prisma migrate dev --name resources
npx nest g resource modules/resources
```

- CRUD de `Resource` (cada uno pertenece a una `Branch`).
- `PUT /services/:id/resources` — qué recursos requiere el servicio.

**✅ Done cuando:** podés modelar un catálogo realista (categorías, servicios con precio y duración, recursos por sucursal, asignación de quién hace qué dónde).

---

## 👤 FASE 4 — Clientes

Migración: `Customer`, `CustomerTag`, `CustomerTagAssignment`.

```bash
npx prisma migrate dev --name customers
npx nest g resource modules/customers
npx nest g resource modules/customer-tags
```

- Índices `(tenant_id, phone)` y `(tenant_id, email)` para detectar duplicados.
- `POST /customers` — si llega un `phone` que ya existe en el tenant, devolver el existente con un flag `wasMerged: true` (decisión pendiente: ¿merge automático o rechazar?).
- Endpoints de búsqueda con paginación (`GET /customers?search=...&page=...`).

**✅ Done cuando:** búsqueda fluida, no se duplican clientes con el mismo teléfono.

---

## 📅 FASE 5 — Turnos (el corazón)

> La más delicada. Hacela despacio, con tests primero. No avances sin cobertura de los casos borde.

### 5.1 Migración base

`Appointment`, `AppointmentService`, `AppointmentResource`, `RecurrenceGroup`.

```bash
npx prisma migrate dev --name appointments
```

### 5.2 Editar la migración SQL a mano

Prisma **no** genera constraints de exclusión. Abrir la migración recién creada y agregar:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE appointments
  ADD CONSTRAINT appointments_ends_after_starts CHECK (ends_at > starts_at);

ALTER TABLE appointments
  ADD CONSTRAINT appointments_no_employee_overlap
  EXCLUDE USING gist (
    employee_id WITH =,
    tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (
    status NOT IN ('canceled_by_customer', 'canceled_by_business', 'rescheduled')
    AND deleted_at IS NULL
  );

ALTER TABLE appointment_resources
  ADD CONSTRAINT appointment_resources_no_overlap
  EXCLUDE USING gist (
    resource_id WITH =,
    tstzrange(
      (SELECT starts_at FROM appointments WHERE id = appointment_id),
      (SELECT ends_at FROM appointments WHERE id = appointment_id)
    ) WITH &&
  );
```

> El exclusion en `appointment_resources` puede requerir desnormalizar `starts_at`/`ends_at` ahí, o usar un trigger. Decidir al implementar.

### 5.3 AppointmentsModule

```bash
npx nest g resource modules/appointments
```

#### 5.3.1 Endpoint de disponibilidad

`GET /appointments/availability?branchId=&serviceId=&employeeId=&date=YYYY-MM-DD` → array de slots libres.

Algoritmo:

1. Cargar horario de la sucursal para ese día (`BranchBusinessHours` + `BranchSpecialDay` que pueda sobrescribir).
2. Cargar horario del empleado en esa sucursal (`EmployeeSchedule`).
3. Restar `EmployeeTimeOff` que se solape.
4. Restar `Appointment`s existentes del empleado (con estados activos).
5. Restar uso de recursos requeridos por el servicio.
6. Dividir el rango libre en slots del tamaño `duration + buffer`.

**Tests unitarios obligatorios.** Casos borde: día cerrado, día especial, time-off parcial, servicios con buffer, transiciones DST.

#### 5.3.2 Crear turno

`POST /appointments`:

- Validar disponibilidad (re-ejecutar el algoritmo dentro de la transacción).
- **Snapshot** de `duration_minutes` y `price_cents` en `AppointmentService` (no FK al valor actual).
- Si el servicio tiene `deposit_amount_cents` o `tenant_settings.require_deposit_for_booking` → estado inicial `pending_payment`. Si no, `confirmed`.
- Crear `AppointmentResource` para cada recurso requerido.
- Si el exclusion constraint dispara (`23P01`), devolver 409 con mensaje claro.

#### 5.3.3 Máquina de estados

Transiciones permitidas (validar en service, no solo en DTO):

- `pending_payment` → `confirmed` (cuando entra el webhook de pago) | `canceled_by_customer` | `canceled_by_business`
- `confirmed` → `attended` | `no_show` | `canceled_by_customer` | `canceled_by_business` | `rescheduled`
- `attended`, `no_show`, `canceled_*`, `rescheduled` — terminales

Política de cancelación: aplicar `tenant_settings.cancellation_policy_hours` para decidir si corresponde reembolso (full/partial/credit/none).

#### 5.3.4 Reprogramación

`POST /appointments/:id/reschedule`:

- Crea un nuevo `Appointment`, marca el viejo como `rescheduled`, setea `rescheduled_to_id` y `rescheduled_from_id`.
- Mantiene los pagos existentes asociados.

### 5.4 Recurrencia

`POST /appointments/recurring`:

- Recibe `frequency`, `dayOfWeek`, `occurrences`, datos del turno base.
- Genera N turnos en una transacción, todos con el mismo `recurrence_group_id`.
- Si alguno choca con disponibilidad → fallar todo (transacción) o saltearlo con warning (decidir y documentar).

**✅ Done cuando:** podés crear, reprogramar, cancelar y marcar atendido un turno. Doble-booking imposible (testeado con concurrencia: dos requests paralelos al mismo slot, uno tiene que fallar con 409).

---

## 💰 FASE 6 — Pagos

### 6.1 Modelos

`AppointmentPayment`, `SubscriptionPayment`.

```bash
npx prisma migrate dev --name payments
```

### 6.2 Abstracción del provider

`src/modules/payments/providers/`:

- Interfaz `PaymentProvider` con `createPreference()`, `verifyWebhookSignature()`, `getPayment()`.
- Implementación `MercadoPagoProvider` con el SDK oficial.
- Mock para tests.

```bash
npm i mercadopago
```

### 6.3 Endpoints

- `POST /appointments/:id/payments/checkout` — crea preferencia MP para la seña, devuelve `init_point`.
- `POST /webhooks/mercadopago` (público, firma verificada) — actualiza `AppointmentPayment.status` y avanza el `Appointment` de `pending_payment` a `confirmed`.
- `POST /appointments/:id/payments/manual` — para pagos en efectivo/transferencia desde el panel (registra `recorded_by_user_id`).

### 6.4 Suscripciones

- Job o webhook que cree `SubscriptionPayment` al cobrarse la mensualidad.
- Cron diario que baje a `past_due` las suscripciones vencidas. Bloquear creación de turnos si `past_due` por más de N días.

**✅ Done cuando:** un cliente puede pagar la seña con MP y el webhook deja el turno `confirmed` solo. Pagos manuales registrables. Estado de suscripción consistente.

---

## 🌐 FASE 7 — Portal público

### 7.1 Resolver tenant por slug

Endpoints públicos bajo `/public/:slug/...`. Un middleware específico:

1. Resuelve el `Tenant` por `slug`.
2. Inyecta `tenantId` en el ALS (igual que el flujo autenticado).
3. Marca el request como público (no hay `userId`).

### 7.2 Endpoints

- `GET /public/:slug` — branding + info pública del negocio.
- `GET /public/:slug/services` — servicios activos agrupados por categoría.
- `GET /public/:slug/availability?serviceId=&branchId=&date=` — reusa el algoritmo de Fase 5.3.1.
- `POST /public/:slug/appointments` — crea turno + customer si no existe (match por phone), inicia checkout MP.

### 7.3 Throttling agresivo

Aplicar `@Throttle()` específico a estos endpoints (ej. 30 req/min por IP).

**✅ Done cuando:** desde un browser anónimo podés ver el portal, elegir servicio, ver disponibilidad, reservar y pagar la seña.

---

## 📝 FASE 8 — Transversales finales

### 8.1 Notas

Migración: `Note` con `entity_type` ENUM + `entity_id` UUID nullable.

```bash
npx prisma migrate dev --name notes
npx nest g resource modules/notes
```

Endpoints polimórficos:

- `POST /notes` — body con `{ entityType, entityId?, content, isPrivate }`.
- `GET /notes?entityType=customer&entityId=...`.

### 8.2 Auditoría

Migración: `AuditLog`.

Interceptor global `AuditInterceptor` que para cada request mutante (POST/PATCH/PUT/DELETE) registra:

- `action`, `entityType`, `entityId`, `changes` (diff con `deep-object-diff`).
- `ip_address`, `user_agent` del request.

Lo mete en una `Queue` BullMQ para no bloquear la respuesta. Worker consume y persiste.

### 8.3 RLS en Postgres (red de seguridad)

Migración SQL manual:

```sql
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON appointments
  USING (tenant_id = current_setting('app.current_tenant', true)::uuid);
-- repetir para cada tabla con tenant_id
```

En `PrismaService`, antes de cada query (o por transacción):

```ts
await this.$executeRawUnsafe(`SET LOCAL app.current_tenant = '${tenantId}'`)
```

> Validar que no rompa con el connection pool. Idealmente usar `$transaction` y setear el setting al inicio.

### 8.4 BullMQ + Redis

```bash
npm i @nestjs/bullmq bullmq ioredis
```

Sumar Redis al `docker-compose.yml`.

Colas iniciales:

- `appointment-reminders` — encolar al crear/reprogramar un turno (24h y 2h antes). Cancelar al cancelar el turno.
- `audit-logs` — sink del interceptor de 8.2.
- `email` — envío asíncrono.

**✅ Done cuando:** auditoría completa, notas funcionan, RLS activo y testeado (un tenant no puede leer datos de otro ni por bug en código), recordatorios encolados.

---

## 🛡️ FASE 9 — Hardening

### 9.1 Tests E2E sobre DB real

`test/` con setup que levanta un Postgres dedicado (o usa schemas separados). Flujos críticos:

- Registro → primer turno → pago de seña → atención.
- Doble-booking concurrente (debe fallar uno).
- Aislamiento entre tenants (intentar leer/escribir cross-tenant debe dar 404/403).
- Cancelación con/sin reembolso según política.

### 9.2 Carga

`k6` o `artillery` contra:

- `GET /appointments/availability` (el más caro).
- `POST /public/:slug/appointments` con concurrencia.

Target inicial: p95 < 300ms en availability con 50 RPS.

### 9.3 Observabilidad

- **Sentry** para excepciones.
- **OpenTelemetry** → traces a Tempo/Jaeger.
- **Prometheus** scrape de `/metrics` (con `@willsoto/nestjs-prometheus`).
- Dashboards en Grafana: latencia por endpoint, tasa de error, queue depth.

### 9.4 CI/CD

GitHub Actions:

1. Lint + typecheck.
2. Unit tests.
3. E2E con Postgres en service container.
4. Build.
5. Deploy (Railway / Fly / Render / lo que decidan).

### 9.5 Seguridad final

- Audit `npm audit` y Snyk.
- Helmet headers.
- CORS configurado por env.
- Rate limiting endpoint por endpoint.
- Rotación de JWT secret + estrategia de invalidación masiva si hay leak.

**✅ Done cuando:** podés desplegar con confianza y dormir tranquilo.

---

## 🎯 Checkpoints sugeridos para mostrar avances

Si querés mostrar progreso a alguien (socio, cliente piloto), estos son los hitos visibles:

| Checkpoint | Demo posible |
|---|---|
| Fin Fase 1 | Registro + login desde Postman, Swagger andando |
| Fin Fase 3 | Setup completo de un negocio (sucursal, empleados, servicios) |
| Fin Fase 5 | Crear turnos desde el panel, ver agenda |
| Fin Fase 6 | Pagar seña con MP en sandbox |
| Fin Fase 7 | Reservar desde el portal público como cliente final |
| Fin Fase 8 | Recordatorios automáticos llegando |
| Fin Fase 9 | Beta cerrada con 3-5 negocios reales |

---

## ⚠️ Antipatrones a evitar

1. **No repetir filtros de `tenantId` en cada service.** Si lo hacés, la extension de Fase 0 está rota — arreglala ahí.
2. **No usar `Decimal` para plata.** Cents en `Int` siempre.
3. **No persistir fechas en zona local.** UTC en DB, conversión solo al renderizar.
4. **No skipear el exclusion constraint en `appointments`.** La doble reserva es la peor UX posible en este producto.
5. **No mockear Prisma en los tests de turnos.** Usá una DB real — los exclusion constraints solo se prueban contra Postgres.
6. **No empezar el portal público (Fase 7) antes que el panel privado funcione end-to-end.** El portal usa los mismos servicios; si esos no están sólidos, vas a debuggear dos UIs a la vez.
7. **No automatizar suscripciones MP en producción** antes de tener un flujo manual de upgrade/downgrade que funcione. Mercado Pago va a fallar; necesitás un escape hatch.

---

## 📚 Referencias internas

- [`database-reference.md`](./database-reference.md) — modelo de datos completo.
- [`../CLAUDE.md`](../CLAUDE.md) — convenciones del repo y comandos.
- [`../README.md`](../README.md) — setup local.

---

> Última actualización: 2026-05-15.
> Cuando completes una fase, marcala con ✅ acá arriba y actualizá `database-reference.md` si cambió algo del modelo.
