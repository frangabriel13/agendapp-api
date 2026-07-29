# 🧰 Guía de estudio — Herramientas del stack backend

> **Para qué sirve este archivo.** Entender qué hace cada librería del proyecto y **por qué la
> necesito en este SaaS de turnos** (multi-tenant, pagos, portal público). Estructura de cada
> herramienta: **Qué es** · **Para qué sirve** · **Por qué en este proyecto**.
>
> Inventario tomado de `package.json` y `docker-compose.yml`. Complementa a
> [`fase-0-cimientos.md`](./fase-0-cimientos.md).

---

## 🏗️ Framework y lenguaje

### NestJS 11 — el framework principal
- **Qué es.** La estructura sobre la que se construye la API: módulos, inyección de dependencias,
  guards, pipes, interceptors.
- **Por qué en este proyecto.** Un SaaS multi-tenant tiene mucha lógica transversal (auth, tenant,
  permisos) que se repite. Nest le da un lugar ordenado a cada cosa, en vez de `if`s copiados en
  40 controllers. Sin esto, la Fase 5 sería inmantenible.

### TypeScript 5.7 (modo `strict`) — JavaScript con tipos
- **Qué es.** Detecta errores mientras escribo, no en producción.
- **Por qué en este proyecto.** Manejo plata (cents), fechas con zona, estados de turnos, IDs de
  tenant. Un `precio` que sea `string` en vez de `number` es un bug caro; los tipos lo atrapan antes.

### Express 5 — el servidor HTTP por debajo
- **Qué es.** Quien realmente escucha en el puerto 3001. Nest lo usa como motor.
- **Por qué en este proyecto.** Es la base sobre la que corre Nest; casi no lo toco directamente.
  Estándar de la industria en Node.

### RxJS + reflect-metadata — piezas internas de Nest
- **Qué es.** RxJS maneja flujos asíncronos; `reflect-metadata` hace funcionar los decoradores
  (`@Injectable()`, `@Get()`).
- **Por qué en este proyecto.** No los uso a mano, pero Nest no arranca sin ellos.

---

## 🗄️ Base de datos y ORM

### PostgreSQL 16 — la base de datos
- **Qué es.** Donde vive todo: tenants, turnos, clientes, pagos.
- **Por qué en este proyecto (y no otra).** Uso features que otras bases no tienen tan bien:
  **exclusion constraints** para impedir doble-booking (Fase 5), `Timestamptz` para fechas con
  zona, y **Row Level Security** (Fase 8) como red multi-tenant. Es un requisito del diseño.

### Prisma 7 — el ORM (traductor TypeScript ↔ SQL)
- **Qué es.** En vez de escribir SQL a mano, escribo `prisma.customer.findMany()` con
  autocompletado y tipos.
- **Por qué en este proyecto.** Soporta **Client Extensions**, que es lo que uso para el
  tenant-scope y soft-delete automáticos (el corazón de mi multi-tenancy).

### `@prisma/adapter-pg` + `pg` — cómo Prisma se conecta a Postgres
- **Qué es.** `pg` es el driver crudo de Node para Postgres; el adapter hace que Prisma lo use.
- **Por qué en este proyecto.** Elegí el **driver adapter pattern** (decisión no-obvia del
  CLAUDE.md) en vez del motor por defecto: más control sobre la conexión, y es la dirección
  a futuro de Prisma.

### Adminer / Prisma Studio — interfaces visuales para la base
- **Qué es.** Adminer corre en Docker (`:8080`); Prisma Studio se levanta con `npx prisma studio` (`:5555`).
- **Por qué en este proyecto.** Para inspeccionar datos con el mouse mientras desarrollo
  ("¿se creó bien el turno?", "¿quedó seteado el `deletedAt`?"). Prisma Studio entiende mejor
  mi schema.

---

## ✅ Configuración y validación

### Zod 4 — validación con schemas
- **Qué es.** Defino la "forma" que deben tener los datos y Zod verifica.
- **Por qué en este proyecto.** Valida las **variables de entorno al arrancar**. Si falta
  `DATABASE_URL`, la app ni levanta. Elegido en vez de Joi a propósito.

### `@nestjs/config` — maneja las variables de entorno
- **Qué es.** Carga el `.env` y da acceso tipado (`config.get('PORT')`).
- **Por qué en este proyecto.** Centraliza toda la config (URL de la base, puerto, y a futuro
  secretos de JWT y Mercado Pago) en un solo lugar tipado.

### class-validator + class-transformer — validan lo que mandan los clientes
- **Qué es.** Con decoradores (`@IsEmail()`, `@Min(0)`) valido el body de cada request; transforman
  el JSON en instancias de clase con tipos correctos.
- **Por qué en este proyecto.** Cada endpoint recibe datos de afuera que no puedo confiar
  (email, precio, fecha del turno). Son la "aduana" de la API.

---

## 🌐 API, docs y protección

### `@nestjs/swagger` — documentación interactiva
- **Qué es.** Genera la doc de la API en `/api` con botón "probar".
- **Por qué en este proyecto.** Mi frontend necesita saber qué endpoints existen; Swagger lo
  mantiene actualizado desde el código.

### `@nestjs/throttler` — rate limiting
- **Qué es.** Frena a quien haga demasiadas requests.
- **Por qué en este proyecto.** Protege `/auth/login` de fuerza bruta y el **portal público**
  (Fase 7), donde cualquiera anónimo puede pegarle a la API.

---

## 📊 Observabilidad

### nestjs-pino + pino-http — logging estructurado
- **Qué es.** Registran cada request como JSON con un `requestId`.
- **Por qué en este proyecto.** Cuando un turno falle en producción, necesito rastrear qué pasó
  en esa petición exacta. `pino-http` loguea cada request HTTP automáticamente.

### pino-pretty — logs legibles en desarrollo
- **Qué es.** Convierte el JSON crudo en algo con colores mientras programo. Solo en dev.

### `@nestjs/terminus` — health checks
- **Qué es.** Provee `GET /health`, que verifica que la base responde.
- **Por qué en este proyecto.** Al desplegar (Railway/Fly/Render), la plataforma consulta ese
  endpoint para saber si la app está viva. Si la base se cae, `/health` lo reporta.

---

## 🧪 Testing

### Jest + ts-jest — tests unitarios
- **Qué es.** Corren mis tests (`.spec.ts`); `ts-jest` les permite entender TypeScript.
- **Por qué en este proyecto.** La **Fase 5 (turnos) es intocable sin tests**: el algoritmo de
  disponibilidad tiene casos borde brutales (días cerrados, feriados, horario de verano).

### Supertest — tests end-to-end de la API
- **Qué es.** Simula peticiones HTTP reales contra la app (`.e2e-spec.ts`).
- **Por qué en este proyecto.** Para probar flujos completos ("registro → login → reservar") y el
  **doble-booking concurrente** (dos requests al mismo slot, uno debe fallar).

### `@nestjs/testing` — utilidades de test de Nest
- **Qué es.** Deja armar módulos de prueba y mockear dependencias fácil.

---

## 🛠️ Calidad de código y build

### ESLint + typescript-eslint — detectan código problemático
- **Qué es.** Analizan el código y marcan errores de estilo o patrones peligrosos.
- **Por qué en este proyecto.** Atrapan bugs sutiles (variables sin usar, `any` implícitos,
  promesas sin `await`) antes de producción.

### Prettier — formateador automático
- **Qué es.** Deja todo el código con el mismo estilo. Corre con `npm run format`.
- **Por qué en este proyecto.** Para no discutir formato y que el repo se vea uniforme.

### `@nestjs/cli` — línea de comandos de Nest
- **Qué es.** Compila (`nest build`), levanta en watch (`nest start --watch`) y **genera código**
  (`nest g resource modules/appointments`).
- **Por qué en este proyecto.** Cada fase del roadmap arranca con un `nest g resource`: me ahorra
  el boilerplate de cada módulo.

### ts-node / ts-loader / tsconfig-paths / source-map-support — plomería del build
- **Qué es.** Permiten correr y compilar TS, resolver imports con alias, y que los errores en
  producción apunten al código `.ts` original.
- **Por qué en este proyecto.** No los toco casi nunca; hacen que todo lo demás funcione.

---

## 🐳 Infraestructura local

### Docker Compose — levanta los servicios con un comando
- **Qué es.** Con `docker compose up -d` tengo Postgres 16 + Adminer corriendo, sin instalarlos
  en la máquina.
- **Por qué en este proyecto.** Todos usan la misma versión de Postgres, aislada del sistema.
  Cuando la Fase 8 agregue Redis (colas y recordatorios), solo sumo líneas al `docker-compose.yml`.

---

## 🗺️ Resumen por capas

| Capa | Herramientas | Rol |
|---|---|---|
| Recibir y validar requests | NestJS · class-validator · Zod · Throttler | Puerta de entrada segura |
| Guardar datos | PostgreSQL · Prisma · pg · adapter-pg | Persistencia |
| Ver qué pasa | Pino · Terminus · Swagger | Observabilidad y docs |
| No romper nada | Jest · Supertest · ESLint · Prettier · TypeScript | Calidad |
| Correr todo local | Docker Compose | Entorno reproducible |

---

## 📝 Autoevaluación

1. ¿Qué es un ORM y qué me da Prisma frente a escribir SQL a mano?
2. ¿Por qué elegí PostgreSQL específicamente y no otra base?
3. ¿Qué es el "driver adapter pattern" y por qué lo uso?
4. ¿Qué diferencia hay entre Zod (config) y class-validator (requests)?
5. ¿Para qué sirve `@nestjs/terminus` cuando despliegue?
6. ¿Por qué la Fase 5 no se puede hacer sin Jest y Supertest?
7. ¿Qué me resuelve Docker Compose que no resolvería instalar Postgres a mano?
8. ¿Qué diferencia hay entre ESLint y Prettier?
