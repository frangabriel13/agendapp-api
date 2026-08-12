# 🛣️ Roadmap de Desarrollo — AgendApp API

> Guía paso a paso para construir el backend de AgendApp desde el esqueleto actual hasta producción.
> **Leerlo a medida que avanzás.** Cada fase asume completada la anterior.
> Complementario a [`database-reference.md`](./database-reference.md), que es la referencia del modelo de datos.

---

## 📌 Estado actual del repo

> **Fases 0, 1 y 2 cerradas.** El próximo paso es la Fase 3 (catálogo de servicios).

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
- ⏭️ Diferido a propósito: emails transaccionales (reset de contraseña, verificación) — deadline antes de la Fase 7.

**Estructura del negocio (Fase 2)**

- ✅ Migración `20260812112622_branches`: `Branch`, `BranchBusinessHour` y `BranchSpecialDay`, con los CHECK de horario y el índice único parcial de nombre por tenant.
- ✅ `BranchesModule`: CRUD de sucursales con validación de `plan.maxBranches`, horario semanal (`PUT` que reemplaza los 7 días) y días especiales.
- ✅ Migración `20260812122603_employees`: `EmployeeInvitation`, `EmployeeBranch`, `EmployeeSchedule` y `EmployeeTimeOff`; `Employee` completo y `users.password_hash` ahora nullable.
- ✅ `EmployeesModule`: invitación con link de activación (sin email todavía), activación pública, permisos, sucursales asignadas, horario semanal con turno partido y ausencias.
- ✅ Total del repo: **193 tests unitarios + 134 e2e**.
- ⏭️ Diferido: el envío del link por email (misma deadline que el resto de los mails, antes de la Fase 7). Hoy el link viaja en la respuesta de `POST /employees`.
- ❌ Todavía sin RLS (Fase 8) ni catálogo (Fase 3 en adelante).

---

## 🧭 Mapa general de fases

| Fase | Tema | Objetivo |
|---|---|---|
| ✅ 0 | Cimientos transversales | Decisiones base (IDs, soft delete, tenant scoping, logging, swagger) |
| ✅ 1 | Auth + Tenant base | Registro, login, JWT, planes, suscripción |
| ✅ 2 | Estructura del negocio | Sucursales y empleados |
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

### ⏭️ Diferido — Emails transaccionales

**Deadline: antes de la Fase 7 (portal público)**, no en la Fase 8. Lo único que
bloquea esto es tener un proveedor de mail (Resend / SendGrid / SES) y un dominio
con SPF/DKIM. **No** depende de BullMQ: la cola solo aporta reintentos y no
bloquear la respuesta.

- `POST /auth/forgot-password` + `POST /auth/reset-password` (tabla nueva `password_reset_tokens`).
- `POST /auth/verify-email` + reenvío (el campo `users.email_verified_at` ya existe desde la Fase 1).
- **Mandar por mail el link de invitación de empleados**, que hoy vuelve en la respuesta de `POST /employees`. Es sumar el envío, no rehacer el flujo: la tabla de tokens y el endpoint de activación ya son los definitivos.

Cuando toque, el reset de contraseña puede reusar `opaque-token.util.ts` y copiar la forma de `employee_invitations`: token `<id>.<secret>`, hash argon2, un solo uso y vencimiento.

Posponerlo no genera deuda: no toca nada de lo construido en la Fase 1, solo suma
una tabla y endpoints. El riesgo real es el **reset de contraseña** — hasta que
exista, a un usuario que olvida la clave hay que cambiársela a mano en la base.

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

> Última actualización: 2026-08-12 (Fase 1 cerrada, e2e incluidos).
> Cuando completes una fase, marcala con ✅ acá arriba y actualizá `database-reference.md` si cambió algo del modelo.
