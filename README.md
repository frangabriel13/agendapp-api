# Agend App — API

Backend del SaaS multi-tenant de gestión de turnos para dueños de negocios (peluquerías, estéticas, etc).

> El frontend vive en una carpeta aparte (`../agendapp-front`). Esta es solo la API.

---

## Stack

| Capa | Tecnología |
|---|---|
| Framework | NestJS 11 (TypeScript, modo `strict`) |
| Base de datos | PostgreSQL 16 (en Docker) |
| ORM | Prisma 7 con driver adapter (`@prisma/adapter-pg` + `pg`) |
| Validación de envs | `@nestjs/config` + Zod |
| Validación de requests | `class-validator` + `ValidationPipe` global |
| Auth | JWT (`@nestjs/jwt` + `passport-jwt`) + argon2, refresh token opaco con rotación |
| Logs | `nestjs-pino` (JSON estructurado + `requestId`) |
| Docs de la API | Swagger / OpenAPI en `/api` |
| Rate limiting | `@nestjs/throttler` |
| Health checks | `@nestjs/terminus` |
| GUI de DB | Adminer (en Docker) |

---

## Pre-requisitos

Asegurate de tener instalado:

- **Node.js ≥ 20** — recomendado 24.x. Verificá con `node --version`.
- **npm ≥ 10** — viene con Node.
- **Docker** + **Docker Compose** — necesario para levantar Postgres localmente. Si usás WSL, Docker Desktop con WSL integration alcanza.
- **Git** — para clonar.

No necesitás instalar Postgres en tu máquina: corre dentro de Docker.

---

## Setup (primera vez)

### 1. Clonar y entrar al proyecto

```bash
git clone <repo-url> agend-app
cd agend-app/agendapp-api
```

### 2. Instalar dependencias

```bash
npm install
```

### 3. Configurar variables de entorno

Copiá el archivo de ejemplo y dejalo como `.env`:

```bash
cp .env.example .env
```

Los valores por default ya están listos para correr contra el Postgres del Docker Compose. **No necesitás tocar nada** para arrancar en local. Si alguna vez apuntás a otra DB, cambiás `DATABASE_URL`.

> ⚠️ El archivo `.env` está en `.gitignore` y **no se comitea nunca**. Si agregás una variable nueva, sumala a `.env.example` para que el resto del equipo la vea.

### 4. Levantar Postgres + Adminer con Docker

```bash
docker compose up -d
```

Esto levanta:
- **Postgres 16** en `localhost:5432` (usuario `agendapp`, password `agendapp_dev_password`, DB `agendapp`).
- **Adminer** (GUI web de DB) en `http://localhost:8080`.

Verificá que ambos estén `Up` (y Postgres `healthy`):

```bash
docker compose ps
```

### 5. Aplicar las migraciones de Prisma

```bash
npx prisma migrate dev
```

Esto:
1. Crea las tablas en la DB según `prisma/schema.prisma`.
2. Genera el cliente de Prisma tipado en `node_modules/@prisma/client`.

> Si es la primera vez que corre, te va a pedir confirmar el nombre de la migración a aplicar. Solo presioná Enter.

> ⚠️ `prisma migrate dev` **no** regenera el cliente en este setup (Prisma 7 + driver adapters): aplica el SQL y listo. Después de cada migración corré también `npx prisma generate`, o los modelos nuevos no existen en los tipos de TypeScript.

### 6. Cargar el catálogo de planes (seed)

```bash
npx prisma db seed
```

Inserta los 4 planes (Básico, Pro, Avanzado, Empresa). Es **idempotente**: podés
correrlo las veces que quieras y actualiza las filas por `slug`.

> Sin este paso, `POST /auth/register` devuelve 500: todo negocio nuevo arranca en el plan `basico` y no lo va a encontrar.

Opcionalmente, para no tener que crear todo a mano mientras desarrollás:

```bash
npm run seed:demo
```

Deja un negocio (`Peluquería Demo`) con dos sucursales, horarios cargados, un
feriado y tres empleados: el dueño, una profesional con turno partido y una
invitada que todavía no activó su cuenta. Todas las cuentas usan la contraseña
`demo1234`, y el comando imprime el **link de activación** de la invitada para
poder probar esa pantalla.

Se puede correr las veces que haga falta: borra el negocio de demo anterior y lo
vuelve a crear. No toca ningún otro negocio de la base.

### 7. Levantar el servidor en modo dev

```bash
npm run start:dev
```

El server escucha en **`http://localhost:3001`** con hot reload.

### 8. Verificar que todo anda

En otra terminal:

```bash
curl http://localhost:3001/health
```

Tenés que ver:

```json
{"status":"ok","info":{"database":{"status":"up"}},...}
```

Si te devuelve 200 con `database: up`, el setup está completo ✅

Para probar el flujo real de punta a punta, registrá un negocio y pedí tus datos
con el token que te devuelve:

```bash
curl -X POST http://localhost:3001/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"ana@test.com","password":"Password123!","firstName":"Ana","lastName":"Gómez","businessName":"Peluquería Ana"}'

curl http://localhost:3001/auth/me -H "Authorization: Bearer <accessToken>"
```

O directamente desde Swagger en `http://localhost:3001/api` (botón **Authorize**
para pegar el token).

---

## Estructura del proyecto

```
agendapp-api/
├── docker-compose.yml          # Postgres + Adminer
├── prisma/
│   ├── schema.prisma           # modelos de la DB (User, Tenant, Plan, Employee, ...)
│   ├── seed.ts                 # catálogo de planes
│   └── migrations/             # SQL versionado
├── prisma.config.ts            # config de Prisma 7 (DATABASE_URL y seed viven acá)
├── src/
│   ├── main.ts                 # entry point
│   ├── app.module.ts           # root module — middleware + guards globales
│   ├── config/                 # Zod schema + validación de envs
│   ├── common/                 # transversales compartidos
│   │   ├── decorators/         # @Public(), @Roles()
│   │   ├── errors/             # errores propios del dominio técnico
│   │   ├── filters/            # AllExceptionsFilter
│   │   ├── guards/             # RolesGuard
│   │   ├── tenant-context/     # AsyncLocalStorage + middleware
│   │   └── utils/              # slugify, horas y fechas sin instante, transforms
│   ├── prisma/                 # PrismaService + extensions (soft-delete, tenant-scope)
│   └── modules/                # ⭐ feature modules (dominio)
│       ├── health/             # GET /health
│       ├── auth/               # registro, login, refresh, me
│       ├── tenants/            # GET/PATCH /tenants/me (+ branding, settings)
│       ├── branches/           # sucursales + horarios + días especiales
│       └── employees/          # equipo: invitación, horarios, ausencias
├── test/                       # tests e2e
└── .env                        # variables locales (no comiteado)
```

**Convención clave:** todo módulo de dominio nuevo (`users`, `appointments`, etc.) vive bajo `src/modules/`. Cada uno se autocontiene en su carpeta con `*.module.ts`, `*.controller.ts`, `*.service.ts`, y subcarpetas `dto/`, `entities/` cuando aplique.

---

## Cheat sheet de comandos

### NestJS / npm

```bash
npm run start:dev          # dev server con hot reload (lo que vas a usar 99% del tiempo)
npm run start              # arranca una vez, sin watch
npm run start:prod         # corre el bundle de producción (después de build)
npm run build              # transpila TS → JS en dist/
npm run lint               # ESLint con autofix
npm run format             # Prettier sobre src/ y test/
npm run test               # tests unitarios (Jest)
npm run test:watch         # Jest en watch mode
npm run test:cov           # tests con coverage
npm run test:e2e           # tests e2e contra Postgres real
```

> Los **e2e** necesitan el Docker levantado, pero no tocan tu base de desarrollo:
> se crean sola una base `agendapp_test` en el mismo Postgres, le aplican las
> migraciones y el seed, y truncan las tablas entre tests. Si querés apuntarlos a
> otra base (por ejemplo en CI), definí `E2E_DATABASE_URL`.

### Docker (Postgres + Adminer)

```bash
docker compose up -d                # levantar en background
docker compose ps                   # ver estado de los containers
docker compose logs -f postgres     # seguir logs de Postgres en vivo
docker compose stop                 # apagar (preserva los datos)
docker compose start                # volver a prender
docker compose restart postgres     # reiniciar solo Postgres
docker compose down                 # apagar + borrar containers (datos preservados en volumen)
docker compose down -v              # ⚠️ apagar + borrar TODO incluyendo datos (cuidado)
```

### Prisma

```bash
npx prisma migrate dev              # aplicar migraciones pendientes en dev
npx prisma migrate dev --name <n>   # crear nueva migración después de cambiar el schema
npx prisma migrate reset            # ⚠️ borrar DB y reaplicar todas las migraciones desde cero
npx prisma generate                 # regenerar el cliente tipado (después de cambiar schema)
npx prisma studio                   # GUI en localhost:5555 — entiende tu schema, mejor que Adminer
npx prisma db push                  # sincronizar schema sin crear migración (solo prototipos)
npx prisma format                   # formatear schema.prisma
```

### Otros útiles

```bash
# Entrar a la DB con psql (cliente CLI nativo de Postgres dentro del container)
docker exec -it agendapp-postgres psql -U agendapp -d agendapp

# Ver tablas dentro de psql
\dt

# Salir de psql
\q

# Generar un módulo nuevo con el CLI de Nest
npx nest g module modules/users
npx nest g controller modules/users
npx nest g service modules/users
# o todo de una:
npx nest g resource modules/users
```

---

## URLs útiles en local

| URL | Para qué |
|---|---|
| `http://localhost:3001` | API |
| `http://localhost:3001/api` | Swagger (documentación interactiva) |
| `http://localhost:3001/api-json` | El mismo contrato en OpenAPI, para generar clientes |
| `http://localhost:3001/health` | Health check |
| `http://localhost:8080` | Adminer (GUI Postgres) — login: `postgres` / `agendapp` / `agendapp_dev_password` / `agendapp` |
| `http://localhost:5555` | Prisma Studio (cuando corrés `npx prisma studio`) |

> Nota: en Adminer, el campo "Server" tiene que ser `postgres` (nombre del contenedor en la red Docker), **no** `localhost`.

---

## Consumir la API desde el frontend

### CORS

El navegador bloquea que una página de un origen llame a otro, así que los
orígenes permitidos se declaran en `CORS_ORIGINS` (separados por coma). El
default es `http://localhost:3000`, que es el Next de desarrollo.

Si el frontend corre en otro puerto, hay que agregarlo ahí — el síntoma de que
falta es un error de CORS en la consola del navegador, con la request saliendo
en rojo antes de llegar a la API.

Los headers de rate limit se exponen explícitamente (`Access-Control-Expose-Headers`),
porque si no el JavaScript del cliente no los puede leer aunque viajen en la
respuesta. Se llaman `X-RateLimit-Limit-short`, `-long`, etc.: **el nombre del
throttler va como sufijo**.

### Tipos de TypeScript generados

En vez de escribir a mano las interfaces del cliente, conviene generarlas desde
el OpenAPI que ya publica Swagger. Con la API levantada, desde el repo del
frontend:

```bash
npx openapi-typescript http://localhost:3001/api-json -o lib/api-types.ts
```

Salen los enums como uniones de strings, los nullables respetados y las
descripciones como JSDoc. Cuando el backend cambia, se vuelve a correr el
comando y **TypeScript marca en rojo todo lo que quedó roto** en el frontend, en
vez de fallar en runtime.

---

## Cómo agregar un módulo de dominio nuevo

Ejemplo: agregar el módulo `services` (servicios que ofrece cada negocio).

1. **Buscar la tabla en [`docs/database-reference.md`](docs/database-reference.md)** y traducirla a Prisma respetando las convenciones del proyecto: UUID generado por Postgres, plata en cents (`Int`, nunca `Decimal`), fechas `@db.Timestamptz`, `@map`/`@@map` a snake_case, y `tenantId` + `deletedAt` en toda tabla de negocio.

   ```prisma
   // prisma/schema.prisma
   model Service {
     id              String    @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
     tenantId        String    @map("tenant_id") @db.Uuid
     name            String    @db.VarChar(120)
     durationMinutes Int       @map("duration_minutes")
     priceCents      Int       @map("price_cents")
     createdAt       DateTime  @default(now()) @map("created_at") @db.Timestamptz
     updatedAt       DateTime  @updatedAt @map("updated_at") @db.Timestamptz
     deletedAt       DateTime? @map("deleted_at") @db.Timestamptz

     tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

     @@index([tenantId])
     @@map("services")
   }
   ```

2. **Crear migración y regenerar el cliente:**
   ```bash
   npx prisma migrate dev --name services && npx prisma generate
   ```
   `migrate dev` solo aplica el SQL: si no corrés `generate`, los tipos nuevos no existen.

3. **Generar el módulo Nest:**
   ```bash
   npx nest g resource modules/services
   ```
   Te pregunta qué tipo (REST API), y si querés CRUD endpoints — decí que sí.

4. **Inyectar `PrismaService`** en el `ServicesService` y usar **`this.prisma.scoped.service.findMany(...)`**. El `.scoped` es lo importante: filtra por tenant y esconde los borrados solo. Como `PrismaModule` es global (`@Global()`), **no** tenés que importarlo en `ServicesModule`.

5. **Registrar el módulo en `AppModule`.** Los endpoints ya nacen protegidos por el guard global; agregá `@Roles(...)` a los que solo deberían poder tocar el dueño o administración.

---

## Troubleshooting

### "Port 3001 is already in use"
Algo está usando el puerto. Matalo:
```bash
lsof -i :3001     # ver qué proceso lo ocupa
kill <PID>
```
O cambiá `PORT=3002` en `.env`.

### "Can't reach database server at localhost:5432"
Postgres no está corriendo. Levantalo:
```bash
docker compose up -d
docker compose ps    # verificar que esté healthy
```

### "Environment validation failed"
Te falta una variable en `.env` o tiene formato inválido. El error te dice cuál. Compará tu `.env` con `.env.example`.

### Después de un `git pull`, errores raros de tipos o de Prisma
Probablemente cambió `package.json` o `schema.prisma`. Reinstalá y regenerá:
```bash
npm install
npx prisma generate
npx prisma migrate dev
```

### Querés borrar todo y empezar de cero
```bash
docker compose down -v          # borra datos de Postgres
rm -rf node_modules dist
npm install
docker compose up -d
npx prisma migrate dev
npm run start:dev
```

---

## Estado del proyecto

El plan completo está en [`docs/development-roadmap.md`](docs/development-roadmap.md).
Resumen a hoy:

**Listo**

- Cimientos transversales: multi-tenancy con `AsyncLocalStorage` + extensions de Prisma (tenant-scope y soft-delete), logs estructurados, filtro global de errores, Swagger, validación y rate limiting.
- Auth completo: registro de negocio, login, refresh con rotación y detección de reuso, logout, `/auth/me`, cambio de contraseña.
- Guard de JWT global (`@Public()` para abrir rutas) y autorización por rol (`@Roles()`).
- Configuración del negocio: `GET/PATCH /tenants/me`, `/branding` y `/settings`.
- Sucursales: CRUD con límite por plan, horario semanal y días especiales
  (feriados y jornadas con horario distinto).
- Empleados: invitación con link de activación, permisos por rol, sucursales
  asignadas, horario semanal por sucursal (con turno partido) y ausencias.

- Suite de tests: 193 unitarios + 134 e2e contra Postgres real (flujo completo de
  registro a edición del negocio, invitación y activación de empleados, rotación
  de tokens y aislamiento entre negocios).

**Lo que sigue**

- Fase 3: catálogo de servicios. Fase 4: clientes.
- Fase 5: turnos y disponibilidad (el corazón). Fase 6: pagos con Mercado Pago.
- Fase 7: portal público de reservas. Fase 8: auditoría, RLS y jobs con BullMQ.

---

## Recursos

- [NestJS Docs](https://docs.nestjs.com)
- [Prisma Docs](https://www.prisma.io/docs)
- [Zod Docs](https://zod.dev)
- [Terminus (health checks)](https://docs.nestjs.com/recipes/terminus)
