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

### 6. Levantar el servidor en modo dev

```bash
npm run start:dev
```

El server escucha en **`http://localhost:3001`** con hot reload.

### 7. Verificar que todo anda

En otra terminal:

```bash
curl http://localhost:3001/health
```

Tenés que ver:

```json
{"status":"ok","info":{"database":{"status":"up"}},...}
```

Si te devuelve 200 con `database: up`, el setup está completo ✅

---

## Estructura del proyecto

```
agendapp-api/
├── docker-compose.yml          # Postgres + Adminer
├── prisma/
│   ├── schema.prisma           # modelos de la DB (Tenant, ...)
│   └── migrations/             # SQL versionado
├── prisma.config.ts            # config de Prisma 7 (DATABASE_URL vive acá)
├── src/
│   ├── main.ts                 # entry point
│   ├── app.module.ts           # root module — registra los demás
│   ├── config/                 # Zod schema + validación de envs
│   ├── common/                 # decorators / guards / filters compartidos
│   ├── prisma/                 # PrismaService + PrismaModule (global)
│   └── modules/                # ⭐ feature modules (dominio)
│       └── health/             # GET /health
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
npm run test:e2e           # tests e2e
```

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
| `http://localhost:3001/health` | Health check |
| `http://localhost:8080` | Adminer (GUI Postgres) — login: `postgres` / `agendapp` / `agendapp_dev_password` / `agendapp` |
| `http://localhost:5555` | Prisma Studio (cuando corrés `npx prisma studio`) |

> Nota: en Adminer, el campo "Server" tiene que ser `postgres` (nombre del contenedor en la red Docker), **no** `localhost`.

---

## Cómo agregar un módulo de dominio nuevo

Ejemplo: agregar el módulo `services` (servicios que ofrece cada negocio).

1. **Modelar en Prisma:**
   ```prisma
   // prisma/schema.prisma
   model Service {
     id        String   @id @default(cuid())
     tenantId  String
     name      String
     duration  Int      // minutos
     price     Decimal  @db.Decimal(10, 2)
     createdAt DateTime @default(now())
     tenant    Tenant   @relation(fields: [tenantId], references: [id])
   }
   ```

2. **Crear migración:**
   ```bash
   npx prisma migrate dev --name add_service
   ```

3. **Generar el módulo Nest:**
   ```bash
   npx nest g resource modules/services
   ```
   Te pregunta qué tipo (REST API), y si querés CRUD endpoints — decí que sí.

4. **Inyectar `PrismaService`** en el `ServicesService` y usar `this.prisma.service.findMany(...)` etc. Como `PrismaModule` es global (`@Global()`), **no** tenés que importarlo en `ServicesModule`.

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

## Cosas que vienen (roadmap corto)

- Modelado de dominio completo (`User`, `Appointment`, `Service`, `BusinessHours`)
- Multi-tenancy con discriminator column + Prisma extension automática
- Auth con JWT + argon2
- Swagger / OpenAPI en `/api`
- Logger estructurado (`nestjs-pino`)
- BullMQ + Redis para jobs (recordatorios de turnos)

---

## Recursos

- [NestJS Docs](https://docs.nestjs.com)
- [Prisma Docs](https://www.prisma.io/docs)
- [Zod Docs](https://zod.dev)
- [Terminus (health checks)](https://docs.nestjs.com/recipes/terminus)
