# 🛣️ Roadmap de Desarrollo — AgendApp API

> Guía paso a paso para construir el backend de AgendApp desde el esqueleto actual hasta producción.
> **Leerlo a medida que avanzás.** Cada fase asume completada la anterior.
> Complementario a [`database-reference.md`](./database-reference.md), que es la referencia del modelo de datos.

---

## 📌 Estado actual del repo

> **Fases 0 a 6 cerradas, más los mails transaccionales.** El corazón del sistema está: turnos, disponibilidad, recurrencia, y ahora cobros —señas de turnos y la suscripción del negocio—. Los mails se adelantaron (estaban diferidos con deadline "antes de la Fase 7") porque su única deuda real —no poder recuperar una contraseña sin entrar a la base a mano— no convenía arrastrarla más.
>
> **Fase 7 cerrada (2026-09-02).** Desde un navegador anónimo se ve el portal, se elige servicio, se ve la disponibilidad, se reserva y se paga la seña — y una reserva abandonada libera el hueco sola. Las cinco decisiones de producto quedaron escritas con su razón, no solo con su resultado.
>
> **Antes de la Fase 7 se cerró una tanda de deuda chica pedida por el front (2026-09-01).** El front cerró su roadmap y quedaron cuatro cosas del backend, las cuatro hechas: el tipo de ausencia (§2.3), el horario y las ausencias de todo el equipo en un pedido (§2.4), lo que **falta** cobrar de un mes (§6.6) y el choque de ids del sandbox (§6.7). Fueron primero porque era deuda concreta contra deuda hipotética.
>
> **El front terminó el 2026-09-01**: cerró su roadmap en 21 puntos con 83 de los 87 endpoints cableados y sin nada de mock. Los 4 que faltan son los que no corresponde llamar — `/health`, el webhook de Mercado Pago y `/auth/refresh`, que vive adentro de su `lib/api.ts`. Todas las formas de contrato que venían sin ejercitar —paginación `{ data, meta }`, errores con campos extra, el `balance` de pagos, el 402 de la suscripción— ya pasaron por pantallas reales. **Desde acá, lo que traba al front lo destraba el backend.**
>
> Los dos primeros pedidos que vinieron del front después de eso: `GET /payments` —`/reportes` necesitaba lo **cobrado** de un mes y solo existía el saldo de a un turno— y `serviceIds` en la disponibilidad, que ofrecía huecos donde un turno de varios servicios no entraba.

**Cimientos (Fase 0)**

- ✅ NestJS 11 + TypeScript `strict` + Prisma 7 (driver adapter `@prisma/adapter-pg`).
- ✅ `ConfigModule` con validación Zod (`src/config/env.schema.ts`).
- ✅ `PrismaService` global con dos clientes: `prisma.<modelo>` (base) y `prisma.scoped.<modelo>` (extendido).
- ✅ Healthcheck `GET /health` con `PrismaHealthIndicator`.
- ✅ Docker Compose con Postgres 16 + Adminer.
- ✅ `TenantContextService` sobre `AsyncLocalStorage`, global.
- ✅ Extensions de Prisma: soft delete + tenant scope (`src/prisma/extensions/`), con modelos exentos explícitos.
- ✅ Logger estructurado (nestjs-pino + `requestId`), filtro global de excepciones, Swagger en `/api`, `ValidationPipe` global y `ThrottlerModule` con guard global.
- ✅ Migración `20260515120000_enable_extensions` (`pgcrypto` para `gen_random_uuid()`, `btree_gist` para la Fase 5).

**Auth y tenant (Fase 1)**

- ✅ Migración `20260805175327_auth_and_tenant_base`: `User`, `RefreshToken`, `Plan`, `Subscription`, `Tenant`, `TenantBranding`, `TenantSettings` y `Employee` (versión mínima), con los CHECK constraints de la fase y el índice parcial de un solo owner activo por tenant.
- ✅ Seed idempotente de los 4 planes (`prisma/seed.ts`, comando en `prisma.config.ts`).
- ✅ `AuthModule`: `register`, `login`, `refresh` (rotación + detección de reuso por familia), `logout`, `me` y `PATCH /auth/password`.
- ✅ **El tenant-context ya es real**: `TenantContextMiddleware` monta el ALS en cada request y el `JwtAuthGuard` —ahora global— lo resuelve con los datos del token. `prisma.scoped` filtra solo; los services no escriben `tenantId` nunca.
- ✅ `@Public()` para abrir rutas (`/health` y auth pre-login) y `@Roles()` + `RolesGuard` global para autorizar por rol.
- ✅ `TenantsModule`: `GET/PATCH /tenants/me`, `/tenants/me/branding` y `/tenants/me/settings`.
- ✅ **45 tests e2e** sobre Postgres real (base dedicada `agendapp_test`), más 42 unitarios.
- ✅ Emails transaccionales (reset de contraseña y verificación): estaban diferidos, se hicieron antes de la Fase 6. Ver el bloque más abajo.

**Estructura del negocio (Fase 2)**

- ✅ Migración `20260812112622_branches`: `Branch`, `BranchBusinessHour` y `BranchSpecialDay`, con los CHECK de horario y el índice único parcial de nombre por tenant.
- ✅ `BranchesModule`: CRUD de sucursales con validación de `plan.maxBranches`, horario semanal (`PUT` que reemplaza los 7 días) y días especiales.
- ✅ Migración `20260812122603_employees`: `EmployeeInvitation`, `EmployeeBranch`, `EmployeeSchedule` y `EmployeeTimeOff`; `Employee` completo y `users.password_hash` ahora nullable.
- ✅ `EmployeesModule`: invitación con link de activación, activación pública, permisos, sucursales asignadas, horario semanal con turno partido y ausencias.
- ✅ El link de invitación **ahora también sale por mail**, y sigue viajando en la respuesta de `POST /employees` (ver `emailSent`): si el proveedor está caído, el dueño tiene con qué.

**Catálogo (Fase 3)**

- ✅ Migración `20260818145928_services`: `ServiceCategory`, `Service` y `EmployeeService`, con el índice único parcial de nombre de categoría por tenant y los CHECK de duración, precio, seña y formato de color.
- ✅ Migración `20260818151406_resources`: `Resource` y `ServiceResource`, con el índice único parcial de nombre **por sucursal** (no por tenant: el mismo nombre puede repetirse en dos locales).
- ✅ `ServiceCategoriesModule`: CRUD. Dar de baja una categoría deja sus servicios sin categoría en vez de arrastrarlos — el `ON DELETE SET NULL` de la FK no se dispara con baja lógica, así que lo hace el service.
- ✅ `ServicesModule`: CRUD, `PUT /services/:id/employees` (quién lo presta **y en qué sucursal**) y `PUT /services/:id/resources`.
- ✅ `ResourcesModule`: CRUD por sucursal, con `plan.includesResources` como gate del alta.
- ❌ Todavía sin RLS (Fase 8) ni turnos (Fase 5 en adelante).

**Clientes (Fase 4)**

- ✅ Migración `20260819162013_customers`: `Customer`, `CustomerTag` y `CustomerTagAssignment`, con el índice único parcial de teléfono por tenant, el de nombre de etiqueta por tenant y los CHECK de nombre, teléfono, fecha de nacimiento y formato de color.
- ✅ **Un teléfono, un cliente.** La columna `phone_normalized` (solo dígitos, últimos 10 — `src/common/utils/phone.util.ts`) es la que compara el unique; `phone` guarda lo que la persona tipeó. `POST /customers` con un teléfono repetido devuelve **409 con la ficha existente en `existingCustomer`**: no hay merge automático, porque dos personas pueden compartir teléfono y unir dos historiales es una decisión del mostrador. `PATCH` pasa por el mismo chequeo.
- ✅ `CustomersModule`: CRUD, búsqueda paginada (`GET /customers?search=&tagId=&page=&pageSize=`) y `PUT /customers/:id/tags`. La búsqueda cruza nombre, apellido, email y teléfono normalizado, y con varias palabras exige que todas aparezcan en el nombre completo, en cualquier orden.
- ✅ `CustomerTagsModule`: CRUD con `customerCount` de clientes vivos. Dar de baja una etiqueta la saca de todos los clientes.
- ✅ Paginación compartida en `src/common/dto/pagination.dto.ts` (`{ data, meta }` por offset). La estrenan los clientes; la van a reusar el historial de turnos y el de pagos.
- ✅ `AllExceptionsFilter` ahora deja pasar los campos extra que un service adjunte al cuerpo de un error — es lo que permite que el 409 lleve la ficha.

**Turnos (Fase 5)**

- ✅ Migración `20260819175745_appointments`: `Appointment`, `AppointmentService`, `AppointmentResource` y `RecurrenceGroup`, con los CHECK de rango, precio, seña y coherencia de `canceled_at`, y **dos EXCLUDE constraints** que hacen el doble-booking imposible a nivel base.
- ✅ **`GET /appointments/availability`** — cruza el horario de la sucursal con el del profesional y resta ausencias, turnos tomados y recursos ocupados. La aritmética de intervalos vive en `src/modules/appointments/availability.ts` (funciones puras, con tests de casos borde) y la conversión de hora de pared a instante en `src/common/utils/timezone.util.ts`, con tests contra transiciones reales de horario de verano.
- ✅ **`POST /appointments`** — congela precio y duración en `appointment_services` (snapshot), calcula el fin con duración + buffer, y decide el estado inicial según `requireDepositForBooking`. No exige coincidir con un slot de la grilla: alcanza con que entre en el tiempo libre, para poder agendar a alguien que llegó sin turno.
- ✅ **Máquina de estados** en `status-machine.ts` (pura y testeada). Cancelar sella `canceledAt`, libera los recursos y devuelve en `refund` qué corresponde según la política del negocio — sin mover plata, que es la Fase 6.
- ✅ **`POST /appointments/:id/reschedule`** — crea un turno nuevo y deja el viejo en `rescheduled`, enlazados. Copia los servicios con el precio que tenían.
- ✅ **`POST /appointments/recurring`** — series semanales, quincenales y mensuales. Las fechas se generan en calendario puro (`recurrence.ts`), así una serie que cruza un cambio de hora sigue cayendo a la misma hora de pared.
- ✅ `GET /appointments?from=&to=` para el calendario, `GET /:id`, `PATCH /:id` (solo notas).
- ❌ Todavía sin RLS (Fase 8) ni pagos (Fase 6).

**Mails transaccionales (adelantados de la deadline "antes de la Fase 7")**

- ✅ Migración `20260820170603_user_tokens`: `UserToken` con enum `UserTokenPurpose` (`PASSWORD_RESET`, `EMAIL_VERIFICATION`). **Una sola tabla para los dos casos**: comparten forma (`<id>.<secret>`), un solo uso, vencimiento y la regla de que emitir uno nuevo revoca el anterior. `employee_invitations` queda aparte porque es otra cosa: apunta a un `Employee` y está scopeada por tenant.
- ✅ Infraestructura de correo en `src/common/mail/` (módulo `@Global`, como `PrismaModule`): interfaz `MailProvider`, `LogMailProvider` (default, escribe los links en la consola) y `ResendMailProvider` (HTTP directo, sin SDK — mandar un mail es un `POST` y Node trae `fetch`).
- ✅ `POST /auth/forgot-password` + `POST /auth/reset-password`. El reset cambia la contraseña y **cierra todas las sesiones en la misma transacción**: si el reset se pidió porque alguien más entró, dejarle la sesión viva lo volvería inútil.
- ✅ `POST /auth/verify-email` + `POST /auth/verify-email/resend`. El registro manda el mail solo.
- ✅ El link de invitación de empleados sale por mail, con el nombre del negocio en el asunto.
- ✅ **31 tests nuevos** (12 unitarios + 22 e2e, incluido el flujo completo de reset leyendo el token del mail).
- ⏭️ Sigue pendiente: sacar el envío del request y darle reintentos (BullMQ, Fase 8). Hoy se espera al proveedor con un timeout de 10 s.

**Tres decisiones del correo que conviene no revisar sin motivo**

1. **Un mail que falla nunca voltea el request.** `MailService` atrapa, loguea y devuelve `false`. Un proveedor de mail caído no puede impedir que se registre un negocio ni que se emita un token — eso sería mucho peor que un mail perdido. Por eso `POST /employees` devuelve `emailSent` y sigue trayendo `activationUrl`.
2. **`forgot-password` responde 204 exista o no la cuenta.** Contestar distinto lo convertiría en un enumerador de emails registrados que no necesita credenciales. Lo que la respuesta uniforme no tapa es el tiempo; eso lo acota el throttle de 5/min y lo cierra del todo la cola.
3. **El propósito del token es parte de lo que se valida.** Si no lo fuera, el link de verificación —que se manda solo, sin que nadie lo pida— serviría para cambiar la contraseña.

**Pagos (Fase 6) — cerrada**

- ✅ Migración `20260820182921_payments`: `AppointmentPayment`, `SubscriptionPayment` y sus tres enums, con `mp_payment_id` UNIQUE (idempotencia del webhook) y los CHECK de monto, moneda, coherencia `status`/`paid_at` y método vs. id de MP.
- ✅ `PaymentProvider` con dos implementaciones: `MercadoPagoProvider` (HTTP directo, sin SDK) y `SandboxPaymentProvider` (el default, y el modo de desarrollo: cada checkout deja un pago aprobado esperando).
- ✅ `payment-balance.ts`: la única definición de "cuánto pagó", como función pura.
- ✅ **Cuatro endpoints**: saldo del turno, checkout online, webhook y pago manual (incluidas devoluciones en el mostrador).
- ✅ **El webhook es idempotente de verdad**, con test: el mismo aviso dos veces —y dos avisos simultáneos— dejan una sola fila y el mismo saldo.
- ✅ **Suscripciones**: estado y cobro del mes (`/tenants/me/subscription`), cron diario que vence lo impago, y `@RequiresActiveSubscription()` sobre el alta de turnos con ventana de gracia. Responde **402**, y **no** bloquea leer, cancelar ni reprogramar.
- ✅ Migración `20260820211847_subscription_checkout`: `mp_preference_id` y `checkout_url` en `subscription_payments`, para que pedir el link dos veces no genere dos cobros del mismo mes.
- ✅ El seed de demo ahora crea la fila de `Subscription` que le faltaba: el negocio de demo tenía el espejo (`Tenant.subscriptionStatus`) sin la fuente.
- ✅ La app no levanta si `PAYMENT_PROVIDER=mercadopago` y falta el token o el secreto de webhook.
- ⏭️ Falta, fuera del plan original: **débito automático** (preapproval de MP) y **devolución automática** (hoy se registra que se devolvió plata, pero no se le ordena a MP que la devuelva).

- ✅ Total del repo: **450 tests unitarios + 381 e2e**, 86 endpoints.

**Tres cosas que la Fase 6 y el portal van a dar por sentadas**

1. **El doble-booking lo impide la base, no el código.** El chequeo previo de disponibilidad es para dar un mensaje lindo; quien desempata dos reservas simultáneas es el EXCLUDE constraint. Cualquier camino nuevo que inserte turnos tiene que capturar esa violación y traducirla a 409 — Prisma **no** la traduce sola (ver `src/prisma/exclusion-violation.ts`).
2. **`appointment_resources` guarda copia de `starts_at`, `ends_at` y `blocks_slot`.** Es el espejo que el EXCLUDE de recursos necesita, porque un índice no puede leer otra tabla. Lo escribe un solo método (`AppointmentsService.syncResourceMirror`): todo cambio de horario o de estado tiene que pasar por ahí.
3. **`NON_BLOCKING_STATUSES` y el `WHERE` de los EXCLUDE dicen lo mismo.** Si aparece un estado nuevo, van los dos lados.

---

## 🧭 Mapa general de fases

| Fase | Tema | Objetivo |
|---|---|---|
| ✅ 0 | Cimientos transversales | Decisiones base (IDs, soft delete, tenant scoping, logging, swagger) |
| ✅ 1 | Auth + Tenant base | Registro, login, JWT, planes, suscripción |
| ✅ 2 | Estructura del negocio | Sucursales y empleados |
| ✅ 3 | Catálogo | Servicios, categorías, recursos |
| ✅ 4 | Clientes | Customers + tags |
| ✅ 5 | Turnos (corazón) | Appointments + disponibilidad + recurrencia |
| ✅ 1.7 | Mails transaccionales | Reset de contraseña, verificación, invitación por mail (venía diferido de la Fase 1) |
| ✅ 6 | Pagos | Mercado Pago: señas de turnos y suscripción del negocio |
| 7 | Portal público | Endpoints sin auth para reservar online |
| 8 | Transversales finales | Notas, auditoría, RLS, jobs (BullMQ) |
| 9 | Hardening | E2E, observabilidad, métricas, carga |

**Heurística clave:** la Fase 5 (turnos) es la más delicada. Todo lo anterior existe para que esa fase se construya sobre datos sanos. **No te adelantes a turnos** sin tener empleados, servicios y horarios firmes.

---

## 🏗️ FASE 0 — Cimientos transversales

> **Fase cerrada.** Lo que sigue es el plan original tal como se escribió; queda como
> registro de las decisiones (por eso habla en presente de cosas que ya se resolvieron,
> como el `Tenant` placeholder con `cuid()` que se eliminó).

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

> El middleware quedó para la **Fase 1.4**, cuando ya existía el JWT del cual sacar el tenant. La Fase 0 solo dejó el `TenantContextService`.

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

### ✅ 1.1 Migración: auth + tenant

Modelos creados en la migración `20260805175327_auth_and_tenant_base`: `User`,
`RefreshToken`, `Plan`, `Tenant`, `Subscription`, `TenantBranding`,
`TenantSettings` y `Employee`.

**Cómo quedó, vs. lo planeado:**

- Se sumaron `TenantBranding` y `TenantSettings` acá (el plan original los dejaba para 1.5): `register` las crea en la misma transacción, así que ningún tenant nace sin configuración.
- `Employee` entró en **versión mínima** (`tenantId`, `userId`, `role`, `isOwner`, `isActive`) porque el registro necesita crear al owner. `hiredAt`, `bio` y `avatarUrl` van en la Fase 2.
- El `RefreshToken` **no es un JWT**: es opaco (`<id>.<secret>`), con `familyId` para agrupar la cadena de rotaciones y poder revocar toda la familia ante un reuso.
- La migración se editó a mano para agregar SQL que Prisma no genera: índice parcial de un solo owner activo por tenant y los CHECK constraints de la fase (período de suscripción coherente, porcentaje de reembolso 0-100, parcial exige porcentaje, ventanas no negativas).

### ✅ 1.2 Seeds de planes

`prisma/seed.ts` con los 4 planes (Básico, Pro, Avanzado, Empresa), idempotente
por `slug` — es la fuente de verdad del catálogo: cambiás un precio ahí, volvés
a correrlo y la fila se actualiza.

En Prisma 7 el comando **no** va en la clave `prisma` de `package.json` sino en
`prisma.config.ts` (`migrations.seed`). Correr: `npx prisma db seed`.

> Sin este seed, `POST /auth/register` responde 500: no encuentra el plan `basico`.

### ✅ 1.3 AuthModule

Endpoints (`src/modules/auth/`):

- `POST /auth/register` — crea `User` + `Tenant` + `Employee` (owner) + `Subscription` (trial) + branding + settings **en una transacción**.
- `POST /auth/login` — devuelve `{ accessToken, refreshToken }`.
- `POST /auth/refresh` — rotación: revoca el viejo, emite uno nuevo con el mismo `familyId`.
- `POST /auth/logout` — revoca el refresh token y toda su cadena. Es `@Public()` a propósito: alcanza con el refresh token, así se puede cerrar sesión con el access token ya vencido.
- `GET /auth/me` — user + tenant + employee.
- `PATCH /auth/password` — extra, no estaba en el plan: cambia la contraseña y cierra todas las sesiones abiertas.

Detalle importante: `JwtStrategy.validate` **relee al empleado de la base en cada
request** en vez de confiar en el contenido del token. Si lo desactivan o le
cambian el rol, pierde el acceso en el acto y no cuando expire el token.

### ✅ 1.4 Guard global + tenant-context real

Tres piezas, en este orden dentro del request:

1. **`TenantContextMiddleware`** (`src/common/tenant-context/`) monta el `AsyncLocalStorage` llamando a `next()` dentro de `als.run(...)`, así todo lo que viene después (guards, interceptors, handler, filtros) queda en el mismo contexto asincrónico. Registrado en `AppModule.configure()` con `forRoutes({ path: '{*path}', method: RequestMethod.ALL })` — la sintaxis de wildcard de Express 5; el viejo `'*'` funciona pero avisa que está deprecado.
2. **`JwtAuthGuard`** global (`APP_GUARD`): autentica y, apenas passport valida el token, empuja `tenantId`/`userId`/`employeeId`/`role` al store con `tenantContext.set(...)`. `@Public()` (`src/common/decorators/`) abre las rutas que quedan afuera.
3. **`RolesGuard`** global + `@Roles(...)`: autorización por rol. No estaba en el plan original, pero sin esto cualquier `PROFESSIONAL` podía editar la configuración del negocio. No hace nada si el handler no declara roles.

**Por qué middleware y no interceptor:** cuando corre el middleware todavía no
pasaron los guards, así que no hay `request.user`. Por eso el store nace **vacío**
y el guard lo completa mutando el mismo objeto (`mount()` + `set()`). Eso sumó un
valor posible más para `store.tenant`, que ahora tiene tres:

| `store.tenant` | Significa | Qué hace la extension |
|---|---|---|
| `TenantContext` | request autenticado | inyecta `tenantId` |
| `null` | `runWithoutTenant()` | passthrough |
| `undefined` | montado pero sin resolver (ruta pública o sin auth) | **lanza** `TenantContextMissingError` |
| — (`getStore()` es `undefined`) | ALS nunca montado: fuera de un request | **lanza** `TenantContextMissingError` |

Nunca se degrada a "query sin filtro": si el contexto no se resolvió, la query
falla.

### ✅ 1.5 TenantsModule

`src/modules/tenants/` — `GET/PATCH /tenants/me`, `/tenants/me/branding` y
`/tenants/me/settings`. Lectura para cualquier empleado; edición restringida a
`OWNER` y `ADMINISTRATIVE` con `@Roles()`.

Decisiones que conviene recordar:

- **El `slug` no se edita acá.** Es la URL pública del portal (Fase 7) y cambiarlo rompe links ya compartidos. Cuando haga falta, endpoint propio que valide reservados/duplicados y —idealmente— deje un redirect del slug viejo.
- **Nullables del branding:** ausente = no tocar, `null` explícito = borrar.
- **Los updates de branding/settings usan `updateMany` sin `where`**, dejando que la extension inyecte el `tenantId` (antipatrón #1). `Tenant` sí se filtra por `id` a mano porque está en `TENANT_EXEMPT_MODELS`.
- La regla "reembolso parcial exige porcentaje" se valida en el service (400 con mensaje claro) **y** en la base con un CHECK.

### ✅ 1.6 Tests E2E del flujo completo

45 tests en `test/auth.e2e-spec.ts` y `test/tenants.e2e-spec.ts`, corriendo
contra Postgres de verdad.

**Infraestructura** (reusable de acá en adelante):

- **Base dedicada `agendapp_test`**, hermana de la de desarrollo en el mismo Postgres. `test/global-setup.ts` la crea si no existe, corre `prisma migrate deploy` y el seed de planes. Se puede apuntar a otra con `E2E_DATABASE_URL` (CI). Los tests truncan todo entre casos menos `plans`, descubriendo las tablas solas — no hay lista que mantener.
- `test/utils/e2e-app.ts` levanta la app **con los mismos guards, pipe y filtro que producción** y expone `registerTenant()` para armar un negocio en una línea.
- Lo único que se desactiva es el rate limiting (el límite real de 5/min haría fallar los tests por ruido, no por bugs). Probar el throttler queda para la Fase 9.
- `maxWorkers: 1` en `test/jest-e2e.json`: los archivos comparten la base.

**Qué cubren:** el flujo completo de registro a edición del negocio; rotación de
refresh y detección de reuso (el token revocado tumba la familia entera);
revocación de sesiones al cambiar la contraseña; corte de acceso inmediato al
desactivar un empleado; validaciones y campos de contrabando; 401/403/409;
**aislamiento entre dos negocios** en los tres recursos; y la red de seguridad
del tenant-scope (una query scopeada sin contexto falla en vez de devolver todo).

**Cambio que habilitó esto:** `ValidationPipe` y `AllExceptionsFilter` pasaron de
`main.ts` a providers `APP_PIPE` / `APP_FILTER` en `AppModule`. Antes vivían en
el bootstrap, así que la app de los tests no los tenía y se comportaba distinto
que la real.

> **Aprendizaje que salió de escribir estos tests:** las `PrismaPromise` son
> **perezosas** — la query recién se ejecuta cuando alguien llama a su `.then()`.
> Entonces `ctx.runWithoutTenant(() => prisma.scoped.x.findMany())` **falla**: el
> callback devuelve la promesa sin esperarla y la query arranca con el contexto
> ya desmontado. En jobs, seeds y webhooks hay que usar
> `async () => await prisma.scoped.x.findMany()`. Está documentado en el JSDoc de
> `run()` / `runWithoutTenant()` y hay un test que lo fija.

**✅ Done cuando:** podés registrarte, recibir un token, llamar a `/auth/me` y ver tu tenant. Tests E2E del flujo completo.

### ✅ 1.7 Emails transaccionales

Estaba diferido con deadline "antes de la Fase 7". Se hizo antes de la Fase 6
porque la deuda que generaba era concreta: hasta que existiera el reset, a un
usuario que olvidaba la clave había que cambiársela a mano en la base.

**La tabla salió una y no dos.** El plan decía `password_reset_tokens`, pero el
reset y la verificación comparten todo lo que importa —forma `<id>.<secret>`, un
solo uso, vencimiento, y que emitir uno nuevo revoque el anterior—, así que son
`user_tokens` con un enum `purpose`. Lo único que cambia entre los dos es la vida
útil y a qué pantalla del frontend apunta el link. Sumar un tercer caso (cambio
de email, por ejemplo) es un valor del enum, no otra tabla.

`employee_invitations` **no** se absorbió: apunta a un `Employee` y está scopeada
por tenant, mientras que `user_tokens` cuelga de `User`, que es global. Son dos
cosas distintas con la misma forma.

- `POST /auth/forgot-password` + `POST /auth/reset-password`.
- `POST /auth/verify-email` + `POST /auth/verify-email/resend`. El registro dispara el primer mail solo.
- El link de invitación de empleados ahora sale por mail.

**El proveedor es una interfaz** (`src/common/mail/`). El default es
`LogMailProvider`, que no manda nada y escribe los links en la consola: arrancar
el proyecto no debería exigir credenciales de nadie, y probar un reset en local
tampoco. `ResendMailProvider` habla HTTP directo, sin SDK — mandar un mail es un
`POST` con cuatro campos, y una dependencia para eso trae transitivas a cambio de
nada. Para que los mails no caigan en spam hace falta un dominio verificado con
SPF y DKIM; eso es configuración de infraestructura, no de este código.

Lo que sigue pendiente es sacar el envío del request y darle reintentos: hoy se
espera al proveedor con un timeout de 10 s. Es trabajo de la cola (BullMQ, Fase
8) y cuando exista lo único que cambia es el cuerpo de `MailService.deliver`.

---

## 🏬 FASE 2 — Estructura del negocio

### ✅ 2.1 Sucursales

Migración: `Branch`, `BranchBusinessHour`, `BranchSpecialDay`.

```bash
npx prisma migrate dev --name branches
npx nest g resource modules/branches
```

Reglas:

- Al crear una `Branch`, validar `tenant.plan.maxBranches` contra el count actual.
- `BranchBusinessHours`: 7 filas por sucursal (una por día). `is_closed` para días sin atención.
- Constraint: `CHECK (closes_at > opens_at OR is_closed = true)`.

**Cómo quedó:**

- **11 endpoints**: CRUD de `/branches`, `GET`/`PUT` de `/branches/:id/business-hours` y CRUD de `/branches/:id/special-days`. Leer alcanza con estar autenticado; escribir es `OWNER` + `ADMINISTRATIVE`.
- **El primer service que usa `prisma.scoped` de punta a punta.** Ninguna query filtra por `tenantId`: lo pone la extension. El único lugar donde el tenant aparece explícito es la lectura del plan, porque `Tenant` está exento del scoping.
- **`scopedCreate<T>()`** (en `tenant-scope.extension.ts`) resuelve la fricción con TypeScript: los tipos generados exigen `tenantId` en los `create`, pero mandarlo a mano no sirve — el contexto lo pisa igual. El helper apaga el chequeo de esa sola propiedad en vez de un `as any` que apagaría el de todas.
- **La inyección del `tenantId` se endureció**: `applyTenantScope` escribe el del contexto **último** en el spread, así le gana a cualquiera que venga en los args. Antes iba primero, y un `where: { tenantId: 'otro' }` escrito por error lo pisaba: la red de seguridad tenía un agujero en su propia red. Es una función pura y exportada justamente para poder testearla sin levantar Prisma.
- **El horario semanal se reemplaza entero** (`PUT`, no `PATCH`): borrar e insertar los 7 días en una transacción evita el estado ambiguo de "el martes quedó del set anterior".
- **`TIME` y `DATE` viajan como `"HH:MM"` y `"YYYY-MM-DD"`.** Prisma los devuelve como `Date` anclados al 1970-01-01 / medianoche UTC; la conversión está en `src/common/utils/time-of-day.util.ts` y `date-only.util.ts`, y sirve igual para servicios (Fase 3) y turnos (Fase 5).
- **Validación en dos capas**: el service devuelve 400 con un mensaje entendible y los CHECK de Postgres son la red de abajo, para cuando el que escriba sea un job o una query a mano. Los e2e prueban las dos.
- **Límite del plan**: el chequeo corre dentro de la transacción del alta y arranca lockeando la fila del negocio (`SELECT … FOR UPDATE`). Sin eso, dos altas simultáneas contaban las dos lo mismo y entraban las dos — hay un e2e que dispara cinco a la vez y verifica que entre una sola. (Verifiqué que el test falla si se saca el lock: sin él pasan dos.)
- **Limitación conocida**: `closes_at > opens_at` no admite horarios que crucen la medianoche. No aplica al rubro hoy.
- **Tests**: 40 e2e (incluido el aislamiento entre negocios en sucursales, horarios y días especiales) + 26 unitarios nuevos.

### ✅ 2.2 Empleados

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

**Cómo quedó:**

- **13 endpoints.** Leer el equipo alcanza con estar autenticado; administrarlo es `OWNER` + `ADMINISTRATIVE`.
- **La invitación sin email.** Como los mails están diferidos, `POST /employees` **devuelve el link de activación en la respuesta** y el dueño se lo hace llegar al empleado por donde quiera. Cuando exista el proveedor de mail, el email pasa a ser un canal más y el flujo no cambia: la tabla de tokens y el endpoint de activación ya son los definitivos.
- **`users.password_hash` pasó a nullable.** Un invitado tiene cuenta pero no contraseña, y sin contraseña no se puede entrar: `login` lo rechaza con el mismo mensaje y el mismo tiempo que a un email desconocido. TypeScript marcó solo los dos lugares que había que tocar.
- **El token de invitación es opaco** (`<id>.<secret>`, hash argon2), igual que el refresh token — de ahí salió `opaque-token.util.ts`, que ahora comparten los dos y va a usar el reset de contraseña. Se canjea una sola vez, vence a las 72 h y reinvitar revoca el anterior (índice parcial en la base: una sola invitación viva por empleado).
- **Todos los rechazos de la activación dicen exactamente lo mismo.** Distinguir "no existe" de "ya se usó" o "está vencido" le diría a cualquiera con un link viejo si esa cuenta existe y en qué estado está. Hay un test que lo fija.
- **El horario del empleado NO es como el de la sucursal**: una fila por tramo en vez de una por día, para soportar el turno partido. Un día sin filas es un día que no trabaja. Los tramos no se pueden pisar **ni siquiera entre sucursales distintas** — la persona es una sola.
- **Protecciones**: al dueño no se lo puede desactivar, borrar ni cambiar de rol; nadie puede desactivarse ni darse de baja a sí mismo (evita quedarse afuera del propio negocio). Sacarle una sucursal a un empleado borra el horario que tenía ahí.
- **`status` derivado**: `PENDING` mientras no aceptó la invitación, `ACTIVE` después. Sale de si tiene `passwordHash`, y el mapper arma la respuesta campo por campo justamente para que ese hash no se escape nunca.
- **Tests**: 47 e2e (invitar → activar → loguear, límites del plan, aislamiento entre negocios) + 43 unitarios.

**✅ Done cuando:** se puede crear una sucursal con horarios, invitar un empleado, asignarle sucursales y un horario semanal distinto por sucursal.

### ✅ 2.3 Tipo de ausencia — pedido del front (2026-09-01)

`reason` es texto libre y el panel estaba **adivinando la categoría por palabras
clave**: "me voy a Brasil" no dice "vacaciones" en ningún lado y caía en "otro".
Un archivo entero del front (`absenceKind.ts`) existía solo para eso.

- **Enum `TimeOffKind` con tres valores**: `VACATION`, `LEAVE`, `OTHER`. `LEAVE` es toda licencia —médica, de estudio, por maternidad—: separarlas obligaría a elegir entre cuatro opciones al cargar y ninguna cambia nada aguas abajo. Un valor fuera de la lista es 400.
- **La columna es `NOT NULL DEFAULT 'other'`**, así que no hubo backfill a mano y el POST sigue andando sin el campo. Las ausencias viejas quedan `OTHER`, que acá significa "no se sabe", no "otra cosa" — está anotado en el contrato para que el panel no lo muestre como una categoría real.
- **El default vive en un solo lado.** El servicio no manda `kind` cuando el DTO no lo trae, en vez de poner `OTHER` a mano: con el valor escrito en dos lugares, tarde o temprano dicen cosas distintas.
- **`reason` no se toca.** Sigue siendo la nota humana; `kind` es la parte que la máquina lee. La tentación era derivar uno del otro y es exactamente el bug que se está arreglando.
- **Tests**: 3 e2e nuevos (guarda el tipo, sin tipo queda `OTHER`, un tipo inventado es 400), verificado mutando el arreglo — sacando el paso de `kind` al `create`, el primero falla con `"kind": "OTHER"` donde esperaba `"VACATION"`.

### ✅ 2.4 El horario del equipo en un pedido — pedido del front (2026-09-01)

La grilla semanal del panel armaba **una llamada por empleado** para el horario
y otra para las ausencias. Ya no reventaban el rate limiting, pero seguían
siendo N.

- `GET /employees/schedules?from=&to=&branchId=&isActive=` — por empleado, su horario semanal y sus ausencias. **Tres consultas en total**, no dependen del tamaño del equipo.
- **Va declarado ANTES que `@Get(':id')`.** Si no, `schedules` entra como `:id` y el `ParseUUIDPipe` lo rechaza con un 400 que no explica nada. Mismo motivo que `activate`.
- **Horario y ausencias viajan juntos porque separados mienten.** Un horario sin las ausencias muestra a alguien atendiendo el martes que se fue de vacaciones, y quien los pida por separado tiene que acordarse de cruzarlos siempre. Es una vista, no dos recursos.
- **Sin `@Roles`**, al revés que el reporte de cobros: es exactamente la misma información que `GET /employees/:id/schedules` —que tampoco lo lleva— en un solo pedido. Poner rol acá lo agregaría por la puerta de atrás a un dato que ya es visible.
- **`from`/`to` obligatorios y tope de 92 días.** Acotan solo las ausencias (el horario semanal es una plantilla y no depende del rango). Sin tope la respuesta crece sin techo, y una grilla siempre sabe qué semana está mirando.
- **Con `branchId`, las ausencias sin sucursal entran igual.** `branchId: null` significa "en ninguna", así que también afecta a la que se filtra. Es el test que importa del tramo, y está verificado mutando: sacando el `{ branchId: null }` del `OR`, la ausencia desaparece y el test falla.
- **Una sucursal ajena es 400, no un equipo vacío.** Un id mal escrito devolviendo `[]` parece un negocio sin empleados.
- **Tests**: 9 e2e nuevos.

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

## ✅ FASE 4 — Clientes

Migración `20260819162013_customers`: `Customer`, `CustomerTag`, `CustomerTagAssignment`.

**Duplicados: se rechaza, no se fusiona.** La pregunta que quedaba abierta acá era
si un `phone` repetido debía hacer merge automático o rechazar. Se decidió
rechazar: `POST /customers` devuelve **409** con la ficha existente en
`existingCustomer`, y el mostrador decide si es la misma persona. El merge
silencioso es cómodo hasta que dos personas comparten teléfono (una madre y su
hija, una pareja) y une dos historiales que nadie pidió unir. El flag
`wasMerged` que figuraba en el plan original nunca llegó a existir.

**La comparación va sobre `phone_normalized`, no sobre `phone`.** Solo los
dígitos, y de esos los últimos 10 (`src/common/utils/phone.util.ts`): así
`+54 9 11 5555-1234` y `11 5555-1234` son el mismo cliente. El crudo se guarda
igual, porque es el que se muestra y el que se marca. El unique es un índice
**parcial** sobre los no borrados, así que dar de baja una ficha libera el
número.

- Índice único parcial `(tenant_id, phone_normalized)` e índice común `(tenant_id, email)`. El email **no** es único a propósito: compartir casilla es normal.
- `GET /customers?search=&tagId=&page=&pageSize=` — la búsqueda cruza nombre, apellido, email y teléfono normalizado a la vez. Con varias palabras, todas tienen que aparecer en el nombre completo en cualquier orden ("gonzález maría" encuentra a María González).
- Paginación por offset en `src/common/dto/pagination.dto.ts`, compartida con las fases que vienen.

**✅ Done:** búsqueda fluida, no se duplican clientes con el mismo teléfono.

---

## ✅ FASE 5 — Turnos (el corazón)

Migración `20260819175745_appointments`: `Appointment`, `AppointmentService`,
`AppointmentResource`, `RecurrenceGroup`.

### El SQL que hubo que corregir

El bloque de EXCLUDE que traía este plan **no compila**: proponía leer
`starts_at`/`ends_at` del turno con un subquery adentro del constraint, y
Postgres no admite subqueries en la definición de un índice. De las dos salidas
que el propio plan anticipaba se eligió **desnormalizar**:
`appointment_resources` guarda copia de `starts_at`, `ends_at` y un
`blocks_slot`, y el EXCLUDE va sobre esas columnas. La lógica queda en
TypeScript, donde se testea, en vez de en un trigger invisible desde el código.
El costo —que la copia se desincronice— se acota con un único método que la
escribe (`syncResourceMirror`).

Lo que quedó aplicado:

```sql
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
    tstzrange(starts_at, ends_at) WITH &&
  ) WHERE (blocks_slot);
```

> ⚠️ **Prisma no traduce las violaciones de EXCLUDE.** Un `UNIQUE` roto llega
> como `P2002`, pero un EXCLUDE roto llega como un error crudo del driver. La
> rama que este repo tenía preparada en `AllExceptionsFilter` nunca se
> ejecutaba: sin `src/prisma/exclusion-violation.ts`, **todo doble-booking
> habría salido 500 en vez de 409**.

### Disponibilidad

`GET /appointments/availability?branchId=&serviceIds=&date=&employeeId=`

La cuenta es siempre la misma y cada paso es una función pura de
`availability.ts`:

```
(horario de la sucursal ∩ horario del empleado)
  − ausencias − turnos que ya tiene − recursos ocupados
```

y después se corta en slots de `duración + buffer`. **Todo se convierte a
instantes antes de operar**, con `Tenant.timezone`: mezclar hora de pared con
`TIMESTAMPTZ` falla justo el día que cambia la hora.

Decisiones tomadas al implementar:

- **Los slots van pegados** (paso = duración + buffer), como pedía el plan.
  `splitIntoSlots` recibe el paso por separado, así pasar a una grilla de 15
  minutos es cambiar un argumento.
- **No se filtran los slots que ya pasaron.** El endpoint describe lo que el
  horario permite; el portal público (Fase 7) va a tener que recortarlos.
- **Los recursos de otras sucursales no cuentan**, y si un servicio requiere
  varios en la misma sucursal los necesita a todos. Es la intersección que la
  Fase 3 dejó explícitamente para acá.

#### Varios servicios — pedido del front (2026-08-27)

`POST /appointments` aceptaba `serviceIds` desde el principio, pero la
disponibilidad pedía un `serviceId` único: corte y color en la misma visita
—que es un caso normal— se consultaba con uno solo y **se ofrecían huecos donde
el turno después no entra**. El síntoma era un 409 al confirmar un horario que
la propia API había ofrecido.

- `serviceIds` repetido en la query, con los mismos límites y validaciones que el alta.
- **La duración sale de `totalsOf`, la misma función que usa el alta.** No hay una segunda cuenta: si las dos no coincidieran, el hueco ofrecido no sería el que después entra. Hay un e2e que reserva **el último hueco del día** y lo fija — el primero entra igual con la duración mal calculada, así que un test sobre el primero pasaba con el bug puesto.
- **La validación también se reusa** (`loadServices`): mismos 400 por repetidos, inexistentes o desactivados. Un servicio que no existe pasó de 404 a 400, que es lo que ya contestaba el alta.
- **Los candidatos son una intersección, no una unión.** Un turno lo atiende una sola persona: si Lucía hace corte y Ana hace color pero ninguna las dos, la respuesta es que nadie puede.
- **`noEmployeeForServices`**, hermano de `branchClosed`. `slots: []` tenía tres motivos y solo se distinguían dos. Es el único que **no se arregla cambiando de día**, así que esconderlo detrás de "sin lugar" mandaba al usuario a probar fechas para siempre.
- **Los dos motivos se resuelven juntos, no en cascada.** Si el cerrado cortara antes, un día de descanso taparía que además nadie presta la combinación. Cuesta una query indexada de más y los dos flags quedan siempre ciertos.

### Turnos

- `POST /appointments` — **snapshot** de `duration_minutes` y `price_cents`.
  Estado inicial `pending_payment` solo si hay seña que cobrar y
  `require_deposit_for_booking` está prendido. No exige coincidir con un slot de
  la grilla: alcanza con que entre en el tiempo libre, para poder agendar a
  alguien que llegó sin turno.
- `PATCH /appointments/:id/status` — máquina de estados en `status-machine.ts`.
  Al cancelar, la respuesta trae en `refund` qué corresponde según
  `tenant_settings`; **no mueve plata**, eso es la Fase 6.
- `POST /appointments/:id/reschedule` — crea uno nuevo y deja el viejo en
  `rescheduled`, enlazados. Copia los servicios **con el precio que tenían**.
- `GET /appointments?from=&to=` — rango de fechas para el calendario, no
  paginación: quien lo consume pide "esta semana", no "página 3".

### Recurrencia

`POST /appointments/recurring` — semanal, quincenal o mensual.

**Los que chocan se saltean, no tumban la serie**: vuelven en `skipped` con el
motivo y el resto se crea igual. Rechazar los diez porque uno cae en un feriado
obligaría al mostrador a adivinar cuál era. Consecuencia: cada turno va en su
propia transacción, porque en Postgres el primer error aborta la transacción
entera.

Las fechas se generan en **calendario puro** (`recurrence.ts`): sumar días, no
milisegundos, para que "los lunes a las 10" sigan siendo las 10 después de un
cambio de hora. El mensual recorta al último día del mes (31 de enero → 28 de
febrero) sin arrastrar el recorte a los meses siguientes.

**✅ Done:** se crea, reprograma, cancela y marca atendido. Doble-booking
imposible, con test de concurrencia: dos `POST` en paralelo al mismo slot, uno
201 y otro 409, y un solo turno en la base.

---

## 💰 FASE 6 — Pagos

### ✅ 6.1 Modelos

Migración `20260820182921_payments`: `AppointmentPayment` y `SubscriptionPayment`,
con los enums `PaymentStatus`, `AppointmentPaymentType` y `PaymentMethod`.

**Lo que se sumó a lo que decía el modelo conceptual:**

- **`mp_payment_id` es UNIQUE.** Es lo que hace idempotente al webhook, que MP entrega varias veces y desordenado. Sin eso, un aviso repetido cobra dos veces.
- **`currency`**, congelada del tenant al crear el pago. Un movimiento de plata tiene que poder conciliarse contra el reporte del proveedor años después, y ahí el monto viene con su moneda.
- **`period_start`/`period_end`** en los pagos de suscripción: el período de `subscriptions` se pisa en cada renovación, así que sin esto no queda historial de qué mes pagó cada cobro.
- **`mp_preference_id` y `checkout_url`**, para volver a mostrar el link de pago sin crear otra preferencia.
- **CHECK constraints escritos a mano**: monto positivo, formato de moneda, coherencia entre `status` y `paid_at`, y que los ids de MP solo existan si el método es `mercadopago`. Se probaron los 8 casos de rechazo contra la base antes de seguir.

**La decisión que hay que conocer:** hay **dos formas** de representar plata que
vuelve —`status = refunded` (el proveedor revirtió el pago entero) y una fila
con `payment_type = refund` (devolución nuestra, quizás parcial)— y confundirlas
es el error clásico de esta tabla. Por eso el saldo se calcula en un solo lugar,
`src/modules/payments/payment-balance.ts`, que es una función pura con tests.

### ✅ 6.2 Abstracción del provider

`src/modules/payments/providers/`:

- `PaymentProvider` con `createCheckout()`, `verifyWebhookSignature()`, `paymentIdFromWebhook()` y `getPayment()`.
- `MercadoPagoProvider`: HTTP directo, **sin SDK**. Son dos llamadas y un HMAC; el SDK oficial traería su cadena de dependencias a cambio de envolver `fetch`.
- `SandboxPaymentProvider`: el default, y el modo de desarrollo. Cada checkout deja un pago ya aprobado esperando y anota el id en el log — se le pega al webhook con ese id y el flujo corre entero sin cuenta de MP.

**Tres desvíos respecto de lo que decía este plan:**

1. **`createCheckout`, no `createPreference`.** "Preferencia" es vocabulario de Mercado Pago; una interfaz que lo usa no es una abstracción, es MP con otro nombre.
2. **Se sumó `paymentIdFromWebhook()`.** No se puede actuar sobre un aviso sin sacarle el id, y dónde vive el id es específico del proveedor (MP lo pone en el body o en el query string, y manda avisos de otras cosas por el mismo endpoint).
3. **El mock no vive en los tests, vive en `src/`.** Mismo criterio que `LogMailProvider`: es el modo de desarrollo, no scaffolding de test.

**Y una decisión de seguridad que conviene no revertir sin leer el porqué:** la
verificación de firma **no valida que el `ts` sea reciente**. Una ventana
antirreplay protegería contra reenviar un aviso viejo, pero acá eso no hace
daño: el aviso solo dispara un `getPayment`, el estado sale de ahí y
`mp_payment_id` es único en la base. En cambio, si MP reintenta una entrega
firmada hace horas y la rechazamos por vieja, **se pierde un pago**.

> ⚠️ **Sin verificar contra MP real.** El algoritmo de firma está escrito desde
> la documentación y testeado contra vectores calculados a mano (el hash está
> hardcodeado en el spec justamente para que el formato del manifiesto quede
> fijado). Nadie lo probó todavía contra un webhook de verdad. Es lo primero a
> confirmar cuando haya credenciales.

### ✅ 6.3 Endpoints

- `GET /appointments/:id/payments` — los pagos del turno y el saldo que dejan. **Se sumó al plan**: sin esto el panel no tiene de dónde sacar cuánto se pagó, y el front terminaría recalculándolo mal.
- `POST /appointments/:id/payments/checkout` — crea el cobro pendiente y devuelve el link. Pedirlo dos veces por el mismo concepto y monto **devuelve el mismo link** (`reused: true`) en vez de generar otro cobro vivo.
- `POST /webhooks/mercadopago` — público, firma verificada antes de tocar la base.
- `POST /appointments/:id/payments/manual` — efectivo, transferencia y **devoluciones** en el mostrador. Nace acreditado y guarda `recorded_by_user_id`.

**Qué códigos devuelve el webhook y por qué.** MP reintenta ante cualquier
respuesta que no sea 2xx, así que un error solo tiene sentido cuando reintentar
puede servir:

| Situación | Código | Motivo |
|---|---|---|
| Firma inválida | 401 | No es un aviso legítimo que salió mal: es uno que no vino de quien dice |
| El proveedor no contestó | 502 | Es lo único que reintentar puede arreglar |
| El aviso no es de un pago | 200 | MP manda avisos de otras cosas por el mismo endpoint |
| El pago no está en la base | 200 | Reintentarlo no lo va a encontrar |

**Dónde vive la lógica de confirmar el turno.** En `AppointmentsService`
(`syncPaymentState`), no en pagos. El estado de un turno lo escribe el service
de turnos, incluso cuando el disparador es un cobro: duplicarlo del lado de
pagos dejaría el espejo de recursos y la máquina de estados fuera de su único
dueño. La dependencia va en un solo sentido — turnos no sabe que existen los
pagos.

**El estado del turno solo avanza.** Una seña cubierta confirma un turno que
estaba esperando el pago; una devolución **no lo des-confirma**. Volver atrás no
es una transición válida, y hacerlo en silencio sería peor que el problema: el
turno sigue ocupando su lugar en la agenda, y qué hacer con eso lo decide el
negocio cancelándolo. `depositPaid` sí sigue al saldo en los dos sentidos: es un
dato, no un estado.

**Sin `@Roles`.** Registrar plata no es configurar el negocio, es trabajo de
mostrador, y en una peluquería chica la persona que atiende es la que cobra. El
control no es restringir quién puede sino que quede asentado **quién lo hizo**
(`recordedBy`).

⏭️ **Falta la devolución automática**: hoy se puede *registrar* que se devolvió
plata, pero no ordenarle a MP que la devuelva. `resolveRefund` (Fase 5) ya
calcula cuánto corresponde al cancelar; conectar eso con la API de refunds es
trabajo pendiente.

### ✅ 6.4 Suscripciones

- `GET /tenants/me/subscription` — estado, plan, período, días de atraso, si está bloqueado y el historial de cobros. **Se sumó al plan**, por el mismo motivo que el de turnos: sin esto no hay pantalla de facturación posible.
- `POST /tenants/me/subscription/checkout` — el link para pagar el mes. Con `@Roles(OWNER, ADMINISTRATIVE)`: esto no es trabajo de mostrador, es la cuenta del negocio.
- El aviso entra por **el mismo webhook** que los cobros de turnos. Como el aviso no dice de qué cobro es, se busca primero entre los pagos de turnos y después entre los de suscripción.
- Cron diario a las 3 AM (`@nestjs/schedule`) que pasa a `PAST_DUE` lo vencido.
- `@RequiresActiveSubscription()` + `ActiveSubscriptionGuard` (cuarto guard global) sobre el alta de turnos.

**Lo que no se hizo, a propósito: débito automático.** Cobrar solos todos los
meses es la API de *preapproval* de Mercado Pago, que es una integración
distinta de la del checkout y no estaba en el plan. Hoy el mes se paga con un
link, igual que una seña. Toda la parte de dominio —períodos, vencimiento,
bloqueo, historial— ya está y no cambia el día que se enchufe el débito.

**Qué se bloquea y qué no.** Se corta *crear valor nuevo* (turnos y series), no
operar lo que ya existe: un negocio que debe sigue pudiendo ver su agenda,
cancelar y reprogramar. Cortarle la lectura convierte un problema de cobranza en
un problema para su clientela, que no tiene nada que ver.

**Y deber no alcanza: hay que deber hace rato.** `SUBSCRIPTION_GRACE_DAYS`
(default 7) es la ventana de tolerancia — una tarjeta que rebota se arregla en un
día y dejar a un negocio sin agenda por eso es desproporcionado.

**Responde 402, no 403.** Los dos son "no podés", pero un 403 se confunde con un
problema de permisos: el 402 le dice al frontend, sin leer el mensaje, que lo
que hay que hacer es pagar.

**Dos cosas que hay que sostener:**

1. **`Subscription.status` y `Tenant.subscriptionStatus` son la misma verdad.** La columna del tenant existe porque `/auth/me` la lee en cada request. Hay exactamente dos lugares que cambian el estado y los dos escriben **las dos columnas en la misma transacción**. Tocarlas por separado deja una ventana donde la app muestra un estado y bloquea por otro.
2. **La renovación guarda el `periodEnd` de la fila del pago, no uno recalculado.** Es lo que hace que el aviso repetido de MP no corra el vencimiento un mes más cada vez. Hay un test que lo fija.

⚠️ **El cron corre en cada instancia de la app.** `@nestjs/schedule` no coordina
réplicas. No es un problema porque `expireLapsed` es idempotente, pero cualquier
job que se agregue tiene que serlo también, hasta que exista el lock de la cola
(Fase 8).

**✅ Done cuando:** un cliente puede pagar la seña con MP y el webhook deja el turno `confirmed` solo. Pagos manuales registrables. Estado de suscripción consistente.

### ✅ 6.5 Lo cobrado por período — pedido del front (2026-08-27)

`/reportes` necesitaba lo **cobrado** de un mes y solo existía el saldo de a un
turno: un mes hubieran sido cientos de llamadas contra el throttling.

- `GET /payments` — los cobros de un rango, paginados `{ data, meta }` y con los totales del rango entero. Controller aparte (`PaymentReportsController`): el otro cuelga de `appointments/:appointmentId/payments` y esto no es de un turno.
- **Con `@Roles(OWNER, ADMINISTRATIVE)`, al revés que `PaymentsController`.** Registrar un cobro es trabajo de mostrador; leer toda la plata del negocio de un mes es otra pregunta, y el repo ya trata así esa clase de lectura (`GET /tenants/me/subscription`). La asimetría es deliberada y está escrita en el contrato del front, porque de afuera parece un agujero.
- **Filtra por `paidAt`, no por `createdAt`.** Importa cuándo entró la plata. El único índice sobre el tenant era `(tenant_id, created_at)`, que para eso no sirve: se sumó `(tenant_id, paid_at)` **parcial** con `WHERE paid_at IS NOT NULL`, porque un pago pendiente o fallado no puede caer en un rango.
- **Los días son días del calendario del negocio.** Un cobro de las 21:30 en Buenos Aires es de ese día; armando el rango en UTC caería en el siguiente y el mes no cerraría contra lo que el mostrador vio pasar. Hay un e2e que lo fija, y verificado mutando el arreglo.
- **`status=PENDING` es un 400, no una lista vacía.** Por construcción esos pagos no pueden estar en el rango; dejar pasar el pedido convertiría el malentendido en una respuesta válida. El endpoint informa plata liquidada, no el estado de cobranza del mes.

**Lo importante de este tramo no es el endpoint, es que no aparezca una segunda
definición de "cuánto entró".** El saldo de un turno necesita su
`totalPriceCents`, así que `appointmentBalance` no servía tal cual para un rango
y el camino fácil era sumar a mano —que es exactamente el error clásico de esta
tabla—. Se extrajo `paymentTotals` de `payment-balance.ts`: la regla de qué fila
suma y qué fila resta, sin el turno alrededor. Los totales del rango salen de un
`groupBy` en la base y **cada grupo entra a esa misma función** como si fuera un
pago solo por su suma.

### ✅ 6.6 Lo que falta cobrar — pedido del front (2026-09-01)

`GET /payments` filtra por `paidAt` y **un pendiente no tiene fecha de
acreditación**: no puede caer en ningún rango. La deuda del mes era invisible
salvo mirando turno por turno, que es justamente lo que el otro endpoint vino a
evitar.

- `GET /payments/receivables?from=&to=&branchId=&employeeId=` — paginado `{ data, meta, totals }`, en el mismo controller y con los mismos roles que `GET /payments`.
- **Es un reporte de turnos, no de pagos, y esa es toda la idea.** La fecha de una deuda es la del turno: la única que existe. Un turno de septiembre cobrado en octubre debe en septiembre. Hay un e2e que lo fija en las dos direcciones.
- **El saldo sale de `appointmentBalance`, fila por fila.** No hay `WHERE due > 0` posible —`dueCents` no es una columna, es `max(0, total - pagado)`— y empujarlo a SQL habría obligado a escribir por segunda vez la regla de qué pago suma y cuál resta. El precio, asumido y anotado: el rango entero pasa por memoria antes del recorte, de ahí el tope de 92 días, y `meta.total` cuenta turnos con deuda y no turnos del rango.
- **`OWING_APPOINTMENT_STATUSES` es una constante propia y NO reusa `BLOCKING_STATUSES`** de `availability.ts`, aunque hoy tengan los mismos miembros. Ocupar un hueco en la agenda y deber plata son preguntas distintas: compartir la constante haría que una de las dos respuestas cambie sola el día que aparezca un estado nuevo.
- **Afuera los cancelados y `RESCHEDULED`**: en el reprogramado la deuda se mudó al turno nuevo, y contar los dos la duplica — un error que no se ve mirando una fila, solo mirando el total. Verificado mutando: agregando `RESCHEDULED` a la lista, el test falla con 2 donde esperaba 1.
- **Días del calendario del negocio**, igual que el otro. También verificado mutando: armando el rango en UTC, el turno de las 23:00 del 30 desaparece de septiembre.
- **Tests**: 16 e2e nuevos.

### ✅ 6.7 El choque de ids del sandbox (2026-09-01)

En dev no se podía confirmar el pago de la suscripción, y el aviso contestaba
`applied` como si todo hubiera salido bien.

El contador del `SandboxPaymentProvider` vive **en memoria** y `mpPaymentId`
vive **en la base**: al reiniciar el server el contador volvía a 1 y el id
"nuevo" ya era de una fila vieja. `handleWebhook` busca primero entre los pagos
de turnos y recién después entre los de suscripción, así que el aviso le
acertaba al pago de turno del arranque anterior.

Los ids llevan ahora un prefijo por corrida, que rota también en `reset()`. Un
link de antes del reinicio falla fuerte —"no conozco ese pago"— en vez de
escribir en la fila equivocada, que es lo que hacía este bug difícil de ver.
Verificado mutando: sin el prefijo, el test falla con `Expected: not
"sandbox-payment-1"`.

---

## 🌐 FASE 7 — Portal público

> El plan original de esta fase eran tres bullets (resolver el slug, cuatro
> endpoints, throttling). Revisado contra el código el 2026-09-01, falta bastante
> más — y sobre todo falta lo que hoy no duele porque solo entra gente logueada.

### ✅ 7.0 Cinco decisiones — resueltas el 2026-09-01

Ninguna era de implementación: las cinco cambiaban el producto. Quedaron así.

1. **Qué se expone → un flag propio, solo en `Service`.** `Service.publiclyBookable`, default `true`. Para sucursales y empleados alcanza con `isActive`, que ya existe. En servicios no: "existe en el catálogo" y "un desconocido lo puede elegir solo" son cosas distintas, y el retoque de garantía es el caso.
2. **¿Elige profesional? → las dos, con "cualquiera" de default.** Sale gratis: `findAvailability` ya devuelve `employees[]` por hueco y ya acepta `employeeId` como filtro opcional. Elegir es filtrar.
3. **¿Seña obligatoria? → sí, siempre que el servicio tenga una.** `requireDepositForBooking` sigue gobernando el mostrador y no se toca; el portal no lo mira. Un desconocido que reserva sin poner plata no tiene ningún costo por no aparecer. ⚠️ **Va atada a la limpieza de abandonados (§7.5)**: la seña obligatoria hace nacer el turno en `PENDING_PAYMENT`, que bloquea el hueco mientras espera.
4. **¿Suscripción vencida? → el portal se ve, no se reserva.** No es una preferencia: es la regla que el repo ya tomó para el panel (`blocksNewBookings` corta el alta de turnos y nunca la lectura, con 7 días de gracia). Cortarle la página pública a quien se atrasó un día castiga a su clientela.
5. **¿Cancela solo? → después.** Es una tabla de tokens nueva —`UserToken` cuelga de `User` y un cliente no es un `User`—, un mail más y la pregunta de la devolución de la seña. El mail de confirmación dice a dónde llamar.

### ✅ 7.1 Migración: los campos que faltaban

- **`minBookingNoticeMinutes` y `maxBookingDaysAhead`** en `TenantSettings`. **No es opcional**: `findAvailability` hoy no filtra los slots que ya pasaron —está escrito en la Fase 5.3.1, "el portal público va a tener que recortarlos"— así que sin esto se reserva para dentro de tres minutos, o para dentro de dos años.
- **`publicBookingEnabled`** en `TenantSettings`. **Apaga las reservas, no la página**: el negocio que se llenó el mes deja de tomar turnos sin que se le caiga la URL que compartió. Por eso tampoco toca el `slug`. Viene prendido — un opt-in que hay que ir a buscar no lo activa nadie.
- **`Service.publiclyBookable`**, default `true`: esconder es la excepción.
- Los tres nacen `NOT NULL` con default, así que **no hubo backfill**. Un CHECK ata la ventana a algo que exista: `min >= 0` y `max BETWEEN 1 AND 730` — con `max = 0` no hay ningún día reservable y el portal contestaría siempre vacío, que se lee como un bug y no como una decisión.
- Los tres settings salen y entran por `GET/PATCH /tenants/me/settings`; `publiclyBookable` por `PATCH /services/:id`.
- **Token de gestión del turno**: no va, por la decisión 5.

### ✅ 7.2 Resolver el tenant por slug

Endpoints públicos bajo `/public/:slug/...`.

- **Guard, no middleware.** El plan viejo decía middleware; el repo ya resuelve el tenant en un guard (`JwtAuthGuard` llama a `tenantContext.set(...)` corriendo adentro del ALS que monta `TenantContextMiddleware`). Un guard tiene los route params en el `ExecutionContext`; un middleware de Express tendría que volver a parsear la URL.
- **Orden en la cadena**: va antes de `ActiveSubscriptionGuard`, que hoy deja pasar cuando no hay tenant resuelto.
- Slug inexistente, reservado o de un negocio borrado → **404**. Los reservados ya están en `slug.util.ts`, y `public` está en la lista.
- El contexto queda con `tenantId` y **sin `userId`**, que ya está soportado: es el mismo caso del webhook de pagos.
- **`@PublicTenant()` es `@Public()` + el marcador, en un solo decorador y a nivel controller.** Separarlos dejaría abierta la combinación "público y sin tenant", que es justo la que expondría datos de todos los negocios.
- ⚠️ **El `deletedAt` del guard es lo único que tapa el catálogo de un negocio dado de baja.** La extension de soft delete filtra el borrado de *cada fila*, no el del negocio dueño: sin ese chequeo, `/services` y `/branches` de un negocio eliminado se siguen viendo enteros. El primer test que escribimos no lo detectaba —pegaba solo contra `GET /public/:slug`, donde el 404 sale igual por otro camino— y la mutación lo dejó al descubierto. Ahora recorre las tres rutas.

### ✅ 7.3 Endpoints

- ✅ `GET /public/:slug` — branding, `timezone`, `currency` y las reglas de reserva. El timezone **no es opcional**: sin él el portal pinta las horas mal. `booking` publica la ventana para que el calendario deshabilite los días que no van, en vez de dejar que el visitante se coma un 400.
- ✅ `GET /public/:slug/branches` — **no estaba en el plan original y hacía falta**: para reservar hay que elegir sucursal. Solo las activas, con su horario de atención.
- ✅ `GET /public/:slug/services` — activos **y** públicos, agrupados por categoría. Los sin categoría van al final en un grupo `"Otros"` con `id: null` y **no se esconden**: es un descuido de carga, y sacarlo del portal lo convierte en plata que no entra.
- ✅ Throttle propio del portal (5/s, 60/min), más ajustado que el global porque acá el único costo de pedir es tener una IP.
- ✅ 16 e2e, incluido el aislamiento entre negocios y que nada del panel se filtre en la respuesta.
- ✅ `GET /public/:slug/availability` — el mismo algoritmo de la Fase 5.3.1, recortado por la ventana. Un día fuera de la ventana devuelve `slots: []` y no un 400: el portal ya publica la ventana y puede deshabilitar esos días, y un error rompería una vista de mes entero.
- ✅ `POST /public/:slug/appointments` — matchea el cliente por teléfono (o lo crea), agenda con `createdVia: PUBLIC_BOOKING` y `createdByUserId: null`, y arranca el checkout si hay seña. Throttle propio (3/min, 15/hora), mucho más duro que el de los `GET`: cada reserva **le ocupa un hueco al negocio**, y cincuenta reservas son cincuenta pedidos que el límite de lectura ni nota.
- ✅ **La reserva se valida contra la disponibilidad real, no contra la ventana a mano.** El `POST` pide el mismo día que vería el portal y busca su `startsAt` entre los slots: así "está dentro de la ventana", "la sucursal abre", "alguien lo presta" y "el hueco está libre" salen de una sola fuente. De ahí sale también el profesional cuando no lo eligieron.
- ✅ **"Cualquiera" es el que menos turnos tiene ese día**, con desempate por id. Tomar siempre el primero de la lista le daría todas las reservas web a quien ordene primero — un bug que el negocio ve en un día.
- `GET`/`DELETE /public/:slug/appointments/:token` — no va, por la decisión 5.

### ✅ 7.4 Qué había que tocar del código que ya estaba

- **El recorte de slots vive adentro de `findAvailability`**, detrás de un parámetro opcional. Era la decisión abierta y se resolvió así porque la alternativa —una segunda implementación en el portal— es exactamente el error que ya nos costó un 409 con la duración de varios servicios: la disponibilidad que se ofrece tiene que ser la misma que después entra.
- **El filtro se aplica sobre slots ya cortados, no recortando los ratos libres antes de cortarlos.** Recortando antes, un piso a las 10:20 haría arrancar la grilla a las 10:20 y el portal ofrecería horarios distintos a los del panel para el mismo día.
- **`create` se partió en `book` privado + dos entradas**: `create` (mostrador) y `createFromPortal`. Lo que cambia entre las dos son tres cosas y ninguna es configurable: `createdByUserId` en `null` —la columna ya lo admitía, el método no—, `createdVia: PUBLIC_BOOKING` (el enum existía y no lo usaba nadie) y la política de seña.
- **`DepositPolicy` (`'settings'` | `'always'`)** es el nombre de esa última diferencia. No son dos valores igual de válidos: el mostrador y el portal son situaciones distintas, y `requireDepositForBooking` describe la primera.

### ✅ 7.5 Seguridad — la parte que el plan viejo subestimaba

Decía "throttling agresivo, ej. 30 req/min por IP". Eso era lo de menos.

- ✅ **La limpieza de abandonados** (`AppointmentsService.releaseAbandoned` + `AppointmentsCron`, cada 10 minutos). Un `PENDING_PAYMENT` está en `BLOCKING_STATUSES`: ocupa al profesional igual que uno confirmado. Mientras los cargaba el mostrador no hacía falta limpiarlos —alguien los miraba—, pero con el portal abierto cada checkout abandonado es un hueco muerto del que nadie se entera. **Es lo que hace segura a la seña obligatoria de la decisión 3.**
  - Solo toca `PUBLIC_BOOKING`: un `PENDING_PAYMENT` del panel puede estar esperando una transferencia, y cancelárselo solo sería peor que el hueco.
  - Queda `CANCELED_BY_BUSINESS` con motivo, no borrado: la clienta puede haber recibido el mail, y que el turno desaparezca sin rastro convierte un reclamo en un misterio.
  - El `status` va también en el `WHERE` del `updateMany`: es lo que resuelve la carrera contra el aviso del proveedor.
  - Cada 10 minutos y no de madrugada como el vencimiento de suscripciones: lo que se libera es un hueco **de hoy**.
- ✅ **Enumeración de clientes por teléfono.** La respuesta del `POST` es idéntica exista o no el número, y **no devuelve nada del cliente** —ni el nombre guardado en la ficha—. Mismo criterio que `POST /auth/forgot-password`. Además, una ficha existente **no se pisa** con lo que vino del formulario: el panel es la fuente de verdad de su propia clientela.
- ✅ **Spam de turnos.** Throttle propio del `POST` (3/min, 15/hora) además del de los `GET`. **No alcanza solo** —las IPs son baratas— y por eso lo que de verdad limita el daño es la limpieza de arriba: un turno sin pagar dura media hora.
- ✅ **No filtrar datos internos**: la respuesta pública trae nombre de sucursal, nombre del profesional y servicios. Nada de emails, notas ni ids internos de más.
- **CORS**: pendiente de configurar el dominio del portal cuando exista. No es código nuevo, es una variable de entorno.

### ✅ 7.6 Mails

- ✅ Confirmación a quien reservó, con el link de pago si falta la seña.
- ✅ Aviso al negocio, **con el teléfono**: es para lo que se abre ese mail.
- **Son dos plantillas y no una con dos destinatarios**: mandar el mismo texto sería o darle el teléfono de la clienta a ella misma, o no dárselo al negocio.
- **El mail cambia entero según haya seña o no.** Con seña el asunto, el cuerpo y el botón dicen que el turno **todavía no está**; un texto único que dijera "reservado" y abajo "pagá la seña" deja a la mitad de la gente creyendo que ya lo tiene.
- La hora se formatea **con la zona del negocio**, nunca con la del proceso: hay un test que lo fija comparando Buenos Aires contra Madrid.

### ✅ 7.7 Tests y contrato

- ✅ 25 e2e nuevos, todos sin token: ver el portal → disponibilidad → reservar → la seña → la limpieza.
- ✅ 14 unitarios nuevos: la ventana de reserva (`withinBookingWindow`) y las dos plantillas de mail.
- ✅ Verificado mutando, cinco veces: ignorar la ventana rompe 3 tests; hacer que el portal mire `requireDepositForBooking` rompe 3; sacarle el filtro por origen a la limpieza rompe el del mostrador; elegir siempre al primer profesional rompe el reparto; y sacarle al `POST` el chequeo de reservas apagadas rompe su 403.
- ✅ `docs/frontend-context.md` actualizado (94 endpoints, el contrato del `POST` y los cinco códigos de error que puede devolver).

### Fuera de alcance, aunque tienten

- **Login del cliente.** Esto es reserva anónima, no un portal con cuentas.
- **Recordatorios automáticos.** Necesitan la cola de la Fase 8.

**✅ Hecho (2026-09-02):** desde un browser anónimo se ve el portal, se elige servicio, se ve la disponibilidad, se reserva y se paga la seña — y una reserva abandonada libera el hueco sola.

---

## 📝 FASE 8 — Transversales finales

> **8.1 a 8.5 cerradas el 2026-09-02.** Queda solo 8.6 (CORS), que es una variable de entorno cuando el portal tenga dominio. El plan original eran cuatro bullets: notas, auditoría, RLS y BullMQ+Redis.
> Revisado contra el código el 2026-09-02, **dos de los cuatro estaban pedidos al
> revés**: la cola de Redis resuelve un problema que todavía no tenemos, y el
> interceptor de auditoría "con diff" no puede cumplir lo que promete desde
> donde está parado.

### 8.0 Cinco decisiones

1. **¿Redis y BullMQ? → No en esta fase.** Lo único que de verdad pedía una cola era el *scheduler* de recordatorios, y eso lo hace un cron que barre cada 15 minutos — exactamente como `releaseAbandoned`, que ya funciona. La auditoría es **un INSERT**: ponerle Redis adelante "para no bloquear la respuesta" es más infraestructura que problema. Y el lock entre réplicas que pide `CLAUDE.md` lo da un **advisory lock de Postgres**, sin sumar un servicio nuevo al despliegue. Redis cuando haya un número que lo pida, no antes.
2. **¿Auditoría global o marcada? → Marcada, con `@Audited(...)`.** Un interceptor que loguee todo body mutante escribe **la contraseña de `POST /auth/login`** en la base: eso no es un detalle de tuning, es un bug de seguridad. Y hay algo que el plan viejo daba por hecho y no se puede: **un interceptor no tiene el estado anterior**, así que "diff con `deep-object-diff`" no tiene contra qué diffear. Lo que sí puede registrar, y alcanza, es *quién*, *qué acción*, *sobre qué entidad*, *con qué datos* y *desde dónde*.
3. **¿RLS de verdad o nada? → De verdad, al final, y con un test que lo pruebe.** Dos cosas que el snippet del plan viejo escondía: **el dueño de la tabla ignora sus propias políticas** salvo `FORCE ROW LEVEL SECURITY`, y **`SET LOCAL` solo vive dentro de una transacción** — con un pool y `prisma.scoped` suelto, cada query saldría sin el setting. Hacerlo bien es un rol de base separado + `FORCE` + una transacción por request. Si no hay un e2e que **rompa la extension a propósito** y muestre que la base igual tapa, es decoración.
4. **`Customer.notes` vs `Note` → conviven, y no es indecisión.** `Customer.notes` es el campo de la ficha, que el front ya usa. `Note` es una bitácora: varias entradas, con autor, fecha y privacidad. Mover una a la otra rompería el contrato del front sin ganar nada.
5. **Recordatorios: ¿por qué canal? → mail, y solo a quien dejó mail.** Es el único canal que existe. Pero **el canal se aísla desde el día uno** (igual que `MailProvider`), para que sumar WhatsApp más adelante sea escribir una implementación y no rehacer el flujo.

### ✅ 8.1 Notas internas (2026-09-02)

Migración: `Note` polimórfica, con `entityType` ENUM (`CUSTOMER`, `APPOINTMENT`, `EMPLOYEE`, `BRANCH`, `GENERAL`) y `entityId` UUID nullable.

- **Polimórfica quiere decir sin FK**: la base no puede garantizar que el destino exista ni cascadear su borrado. Se valida al escribir. El costo real es chico porque **acá nada se borra físicamente** (soft delete en todo el dominio), así que una nota no queda apuntando al vacío.
- **`isPrivate` es una regla de autorización, no un flag decorativo**: la nota privada la ven su autor y el `OWNER`, nadie más. Sin eso, "privada" es una etiqueta que miente.
- `GENERAL` es el único tipo con `entityId` nulo, y al revés: un tipo con entidad **exige** el id. Un CHECK lo ata en la base para que no dependa de que el DTO esté bien.
- Endpoints: `POST /notes`, `GET /notes` (paginado), `GET /notes/:id`, `PATCH /notes/:id`, `DELETE /notes/:id`. Editar y borrar, solo el autor o el `OWNER`.
- **La regla de las dos mitades vive en el service, no en el DTO.** Dos `@ValidateIf` sobre la misma propiedad se pisan entre sí: el primer intento dejaba pasar las dos combinaciones inválidas y el error terminaba saliendo del CHECK de la base como un **500**. Lo encontraron los tests, y el CHECK sigue estando — lo que cambió es que ya no es quien contesta.
- **Una nota privada ajena responde 404, no 403.** Un 403 confirmaría que existe, que es justo lo que "privada" tiene que esconder. Y el filtro va en el `WHERE`, no al armar la respuesta: filtrar en memoria funciona hasta que alguien agrega un `count` y se olvida de repetir la regla.
- **Tests**: 20 e2e. Verificado mutando dos veces: dejar el filtro de privacidad en `{}` rompe 2, y sacar el chequeo de autoría al editar rompe otros 2.

### ✅ 8.2 Auditoría (2026-09-02)

Migración: `AuditLog` (ya está en `TENANT_EXEMPT_MODELS` y en `SOFT_DELETE_EXEMPT_MODELS` desde la Fase 1, esperando esto).

- **`@Audited({ action, entityType })` + `AuditInterceptor`.** Opt-in, por los dos motivos de la decisión 2.
- **Lista de campos que nunca se guardan** (`password`, `token`, `secret`, …), aplicada por nombre y en profundidad. Es la segunda defensa: aunque alguien marque `/auth/login`, la contraseña no llega a la base.
- **Escribe sin bloquear la respuesta y sin voltearla**: si el INSERT falla, va al log y el request sigue. Mismo criterio que los mails — un problema de auditoría no puede convertirse en un problema del usuario.
- **`tenantId` y `userId` son nullables** a propósito: hay acciones del sistema (un cron, un webhook) que no tienen ninguno de los dos.
- Qué quedó marcado: login (y **los que no entraron**), reset y cambio de contraseña, alta/baja/edición de empleados y su activación, cambios de estado y reprogramaciones de turno, y los pagos cargados a mano. Es decir, **lo que alguien podría querer negar después**. Nueve endpoints; las lecturas no se auditan.
- **`GET /audit-logs`, solo `OWNER`**, no estaba en el plan y hacía falta: un rastro que nadie puede leer es una tabla, no una auditoría. Paginado, con filtros por entidad, persona, acción y rango de días del negocio (tope de 92: la tabla no se borra nunca).
- ⚠️ **`AuditLog` está en `TENANT_EXEMPT_MODELS`**, porque su `tenantId` es nullable (un login fallido no tiene negocio). La exención es correcta y tiene una consecuencia peligrosa: **del lado de la lectura no hay extension que filtre**, y el `tenantId` lo pone `AuditLogsService.scopeOf()` a mano. Sin esa línea, cualquier dueño vería el rastro de todos los negocios del sistema. Hay un e2e que la sostiene.
- **Se espera al INSERT antes de responder**, contra lo que decía el plan viejo. Soltarlo (`void record(...)`) suena bien hasta que se ve el efecto: un registro que puede estar o no estar cuando lo mirás no es un registro, y el propio test lo destapó. Son nueve endpoints de baja frecuencia y un INSERT en el mismo pool.
- **`/auth/login` ahora resuelve el contexto de tenant cuando la contraseña verifica.** No es un truco para la auditoría: era el único lugar del sistema que autenticaba a alguien y dejaba el contexto sin resolver, y el síntoma fue que el registro de "quién entró" quedaba huérfano y su propio dueño no podía verlo.
- **Tests**: 12 unitarios de `redactSecrets` y 13 e2e. Verificado mutando dos veces: sacar la censura rompe 3 unitarios y 2 e2e (entre ellos, la contraseña aparece en la base); sacar el filtro por negocio rompe el de aislamiento.

### ✅ 8.3 Recordatorios de turno (2026-09-02)

- Tabla `AppointmentReminder` con **UNIQUE `(appointment_id, kind)`**: el propio unique es lo que hace idempotente al job, igual que `mp_payment_id` con el webhook. Sin eso, dos réplicas mandan dos mails.
- Cron cada 15 minutos que busca turnos que arrancan dentro de la ventana de cada recordatorio (24 h y 2 h). Un turno cancelado no entra: se filtra por estado, no hay nada que "desencolar".
- Solo a quien dejó mail. **Que no haya a dónde mandarlo no es un error**: se marca igual como resuelto para no reintentar todos los cuartos de hora.
- Plantilla propia, con la política de cancelación y a dónde avisar. **Un solo texto para los dos momentos**, con el asunto como única diferencia: la tentación es escribir "tu turno es mañana" en el de la víspera, pero su ventana es de 24 horas y no "el día anterior" — un turno de hoy a la noche entra igual y el mail diría una fecha equivocada.
- ⚠️ **Las dos ventanas no se pisan**: `(0, 2h]` para el inminente y `(2h, 24h]` para el de la víspera. Si la segunda fuera "las próximas 24 horas" a secas, un turno de dentro de una hora entraría en las dos y la clienta recibiría dos mails seguidos diciendo lo mismo. Verificado mutando.
- **Primero se reserva la fila, después se manda el mail.** Al revés, dos instancias mandarían los dos mails antes de que ninguna anotara nada. Verificado mutando: invirtiendo el orden rompen 6 tests.
- **No se recuerda un turno agendado hace menos de una hora**: recordar algo exige que haya habido tiempo de olvidarlo, y sin esto quien reserva para esta tarde recibe la confirmación y, al tick siguiente, un mail recordándole lo que acaba de hacer.
- **Ni los `PENDING_PAYMENT`**: ese turno se libera solo si nadie paga, así que prometerle el horario sería mentir.
- **El mail sale afuera del lock**, porque `JobLockService` sostiene una transacción durante todo el callback y no se espera a un proveedor HTTP con una transacción abierta. Consecuencia aceptada: si el proceso muere entre la reserva y el envío, ese aviso se pierde. Es el lado correcto para fallar — un recordatorio perdido es una molestia, uno duplicado se lee como spam.
- Tope de 200 por corrida: el cron pasa cada 15 minutos y lo que no entra sale en la siguiente.
- **Tests**: 13 e2e.

### ✅ 8.4 El lock de los crons (2026-09-02)

Hoy `@nestjs/schedule` corre en **cada instancia** y lo único que lo hace tolerable es que los dos jobs son idempotentes. Con recordatorios, "idempotente" ya no alcanza: dos réplicas mandarían dos mails a la misma persona (el unique de 8.3 lo ataja, pero por accidente, no por diseño).

- `JobLockService.run(nombre, work)`, `@Global`. Sin servicio nuevo, sin dependencia nueva, y se libera solo si el proceso se cae.
- ⚠️ **Es `pg_try_advisory_xact_lock` y no `pg_try_advisory_lock`, y ahí estaba el costo que el plan viejo escondía.** El de sesión hay que soltarlo a mano, y con un pool de conexiones el `unlock` puede salir por una conexión distinta de la que tomó el lock: el resultado sería un lock que no se libera nunca. El de transacción lo suelta Postgres al terminar, siempre.
- La consecuencia de esa elección: **el trabajo corre con la transacción abierta**, sosteniendo una conexión. Está bien para los jobs que solo consultan, y es exactamente la razón por la que los recordatorios mandan los mails afuera.
- **El lock se toma en el cron, no en el service.** Así `releaseAbandoned` sigue devolviendo cuántos soltó y no "cuántos soltó o `null` si otra instancia lo estaba haciendo", y una llamada directa (un test, un script) corre sin pedir permiso — que es lo que uno quiere de una llamada directa. La excepción es el job de recordatorios, cuya sección crítica es solo el reclamo.
- **Tests**: 3 unitarios de la clave y 4 e2e contra Postgres. El que importa prueba que **de verdad excluye**: si el `pg_try_advisory_xact_lock` no tomara el lock, los dos callbacks entrarían. Verificado mutando.

### ✅ 8.5 RLS en Postgres (2026-09-02)

La red de seguridad final, y la única parte de esta fase que puede salir mal en silencio.

- ✅ **29 políticas** (28 tablas con `tenant_id` más `tenants`, que se filtra por su propio `id`), con `ENABLE` + `FORCE ROW LEVEL SECURITY` y las dos mitades: `USING` para leer y `WITH CHECK` para escribir.
- ✅ **`TenantPool`** (`src/prisma/tenant-pool.ts`): un `pg.Pool` propio que escribe `app.current_tenant` **en cada checkout de conexión**. Sustituye a la "transacción por request" del plan viejo, que no era viable — ver abajo.
- ✅ **Los e2e corren con un rol restringido.** Los 532 tests que ya existían pasan con RLS activo, así que cada uno es además una prueba de que el aislamiento de la base no rompe la aplicación.
- ✅ `npm run db:rls-role` crea el rol de producción; el README explica el cambio de `DATABASE_URL`.

**Lo que el plan escondía, medido:**

- ⚠️ **El rol de la app es superusuario y tiene `BYPASSRLS`.** Con él, la política puesta sobre `branches` dejaba que un negocio viera las sucursales del otro: RLS existía y no cortaba nada. Es el fallo mudo que esta sección venía anunciando, y es de despliegue, no de código.
- ⚠️ **La "transacción por request" del plan original no era viable.** `POST /public/:slug/appointments` habría sostenido una transacción abierta a través de una llamada a Mercado Pago y dos mails — con los locks del EXCLUDE constraint tomados todo ese rato. Eso convierte el camino más disputado del producto en una cola. Por eso el setting se pone en el checkout de conexión y no en una transacción.
- ⚠️ **`current_setting(...)::uuid` revienta con el setting vacío.** Postgres no garantiza cortocircuito en un `OR`, así que el `nullif` va también adentro del cast. Sin eso el error sale en **cada** consulta, no al probar la política.
- ⚠️ **El primer test de contención no probaba nada**: usaba una variable suelta en vez de un `AsyncLocalStorage`, y veinte llamadas concurrentes se pisaban el valor entre ellas.
- ⚠️ **`create` no sirve para probar `WITH CHECK`**: su `INSERT ... RETURNING` lo filtra el `USING` y falla igual. El test pasaba con `WITH CHECK (true)`. Va `createMany`.
- ⚠️ **La trampa de la `PrismaPromise` perezosa** (la que `CLAUDE.md` documenta para `runWithoutTenant`) aparece acá con el peor síntoma posible: sin `await` adentro del contexto, la consulta sale con el setting vacío y **los tests de aislamiento pasan**, porque vacío deja ver todo.

**Tests**: 9 e2e propios, más los 532 de siempre corriendo con RLS activo. Verificado mutando cuatro veces: leer el tenant tarde rompe el de contención; apagar RLS en `tenants` rompe 3; debilitar `WITH CHECK` rompe el de escritura cruzada (después de arreglarlo); quitar `FORCE` **no rompe nada**, y eso también está bien — `FORCE` solo importa si algún día la app comparte rol con el dueño de las tablas.

### 8.6 CORS del portal (deuda de la §7.5)

`CORS_ORIGINS` tiene que incluir el dominio del portal público cuando exista. No es código: es una variable de entorno y una línea en el README.

**✅ Done cuando:** las notas funcionan con su regla de privacidad, lo que alguien podría querer negar queda registrado, los recordatorios salen una sola vez aunque haya tres réplicas, y hay un test que prueba que la base tapa un bug de la aplicación.

---

## 🛡️ FASE 9 — Hardening

### 9.1 Tests E2E sobre DB real

> La infraestructura ya existe desde la Fase 1.6 (base dedicada `agendapp_test`,
> `global-setup` que migra y siembra, helpers en `test/utils/`). Acá se suman los
> flujos que dependen de los dominios de las fases 2 a 7.

Flujos críticos que faltan:

- Registro → primer turno → pago de seña → atención.
- Doble-booking concurrente (debe fallar uno).
- Cancelación con/sin reembolso según política.
- Aislamiento entre tenants sobre los dominios nuevos (el de auth/tenant ya está cubierto).
- Rate limiting: los e2e actuales lo desactivan, así que hay que probarlo aparte.

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

### 9.4 CI — hecha (2026-09-02); falta el CD

`.github/workflows/ci.yml`, tres jobs:

- ✅ **`check`**: lint (sin `--fix`), typecheck, unitarios y build. Va primero y sin servicios: si falla, no vale la pena levantar una base para enterarse de lo mismo cinco minutos después.
- ✅ **`e2e`**: Postgres 16 en service container —la misma imagen que el docker-compose, porque las migraciones usan EXCLUDE, índices parciales y RLS— con `global-setup` armando la base, el seed y **el rol restringido**. Verificado corriendo la suite desde una base y un rol inexistentes, que es lo único que CI hace distinto.
- ✅ **`audit`**, sin bloquear. `npm audit` reporta hoy 19 vulnerabilidades, casi todas transitivas de `prisma`, y su "arreglo" es **bajar Prisma a la 6**. Un CI rojo por algo que no se puede arreglar deja de mirarse; queda como aviso.
- ⚠️ **`npm run lint` lleva `--fix` y no sirve para CI**: arregla y sale en verde, escondiendo la deriva. Por eso ahora hay `lint:check` y `typecheck`.
- Falta el **deploy**: no hay Dockerfile de producción ni destino elegido.

### 9.5 Seguridad final — a medias (2026-09-02)

- ✅ **Helmet**, y **como middleware de `AppModule`, no en `main.ts`**. Es la misma razón que el `ValidationPipe` y el filtro de errores: la app de los e2e se levanta con `createNestApplication()` y no ejecuta el bootstrap, así que lo que viva ahí no se prueba nunca. Puesto donde está, hay 6 e2e que lo fijan — verificado mutando: sin Helmet, 5 se caen.
- ✅ **Swagger no se publica en producción.** No es que sea inseguro: publica el mapa completo de la API —cada ruta, cada campo, cada regla de validación— a cualquiera que pase. La decisión vive en `shouldExposeDocs()` y no en un `if` en `main.ts` para que tenga un test.
- ✅ CORS ya estaba configurado por env desde la Fase 1.
- ✅ `npm audit` en CI, sin bloquear (ver §9.4).
- Falta: rate limiting revisado endpoint por endpoint, y la rotación del `JWT_SECRET` con su estrategia de invalidación masiva.

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

> Última actualización: 2026-08-12 (Fase 1 cerrada, e2e incluidos).
> Cuando completes una fase, marcala con ✅ acá arriba y actualizá `database-reference.md` si cambió algo del modelo.
