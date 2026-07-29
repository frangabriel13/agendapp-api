# 📚 Bitácora de aprendizaje — Fase 0: Cimientos transversales

> **Para qué sirve este archivo.** Es mi guía de estudio del proyecto. Empieza con la Fase 0
> (los cimientos que ya están hechos) y lo voy a ir ampliando con cada fase que complete.
> Objetivo: entender de verdad cómo funciona el backend y poder **explicarlo** en voz alta.
>
> Complementa a:
> - [`../development-roadmap.md`](../development-roadmap.md) — el plan fase por fase.
> - [`../database-reference.md`](../database-reference.md) — el modelo de datos.
> - [`herramientas.md`](./herramientas.md) — qué hace cada librería del stack.

---

## 🎯 ¿Qué es la Fase 0?

La Fase 0 dejó montada **toda la infraestructura transversal** que se usa en cada request,
**antes** de que existiera un solo modelo de negocio. Es el andamiaje: multi-tenancy,
soft-delete, manejo de errores, logs, validación, documentación y rate-limiting ya funcionan,
pero **todavía no hay dominios ni auth que los usen**.

**Estado real del repo hoy:**
- ✅ Toda la infra transversal (los 9 puntos de abajo).
- ✅ Única migración aplicada: `enable_extensions` (pgcrypto + btree_gist).
- ❌ Schema con **0 modelos** de negocio → eso empieza en Fase 1.
- ⚠️ Hueco consciente: el middleware que llena el tenant-context desde el JWT se hace en Fase 1
  (todavía no hay login).

---

## 🧩 Los 9 cimientos

Estructura de cada uno: **Qué es** · **Por qué lo necesito** · **En mi código** · **Concepto clave**.

### 1. IDs UUID v4 + extensiones de Postgres

- **Qué es.** Cada fila lleva un identificador único. En vez de números autoincrementales
  (`1, 2, 3…`) uso **UUID v4** (un string aleatorio de 128 bits).
- **Por qué lo necesito.** En un SaaS multi-tenant, los IDs autoincrementales:
  - filtran información (si mi turno es el `#4718`, se sabe cuántos turnos tengo),
  - son enumerables (alguien pide `/customers/1`, `/2`… y raspa la base),
  - colisionan al mergear datos. Con UUID nada de eso pasa.
- **En mi código.** Migración `20260515120000_enable_extensions` habilita:
  - **`pgcrypto`** → función `gen_random_uuid()` que genera el UUID dentro de Postgres.
  - **`btree_gist`** → habilitada ya, se usa en Fase 5 para el constraint anti-doble-booking.
- **Concepto clave.** Una *extensión* de Postgres es un plugin que agrega funciones/tipos.

### 2. Tenant context (`AsyncLocalStorage`)

- **Qué es.** El problema central del multi-tenant: **una sola base, muchos negocios**. Toda
  query debe filtrar por `tenantId`. Pasar ese id por parámetro a cada función es frágil
  (te olvidás una vez y filtrás datos de otro negocio).
- **Por qué lo necesito.** `AsyncLocalStorage` es como una **mochila invisible que viaja con
  el request**: guardo `{ tenantId, userId }` al inicio y lo leo desde cualquier punto del
  código sin pasarlo por parámetro.
- **En mi código.** `src/common/tenant-context/tenant-context.service.ts`, con 3 estados:
  - `run({ tenantId, userId }, fn)` → request autenticado normal (mochila con tenant).
  - `runWithoutTenant(fn)` → escape hatch consciente (login, seeds, jobs, webhooks): mochila vacía a propósito.
  - `undefined` (nadie montó la mochila) → **bug** → la extension lanza error 500.
- **Concepto clave.** "Contexto de ejecución async" = datos disponibles durante todo el
  request sin pasarlos explícitamente.

### 3. Extensiones de Prisma (soft-delete + tenant-scope)

- **Qué es.** Prisma permite interceptar cada query (como un middleware del ORM). Tengo dos:
  - **Soft-delete:** "borrar" no borra: pone `deletedAt = ahora`. Convierte `delete()` en
    `update()`, y en las lecturas agrega `where: { deletedAt: null }`.
  - **Tenant-scope:** lee el tenant de la mochila (punto 2) e inyecta solo `where: { tenantId }`
    en lecturas y `data: { tenantId }` en creaciones.
- **Por qué lo necesito.** Así **nunca escribo el filtro de tenant ni el de borrados a mano** →
  imposible olvidárselo → no hay fugas entre negocios ni borrados que "reaparezcan".
- **En mi código.** `src/prisma/extensions/`. `PrismaService` expone **dos clientes**:
  - `prisma.scoped.<modelo>` → CON las dos magias. **Default para services de negocio.**
  - `prisma.<modelo>` → crudo, SIN magia. Solo health, login pre-token, seeds.
- **Concepto clave.** Client Extension = interceptor a nivel ORM. Doble cliente = "con
  asistentes de seguridad" vs. "manual".

### 4. Logging estructurado (Pino)

- **Qué es.** Cada log es un **objeto JSON con campos** (`level`, `time`, `requestId`, `msg`),
  no un `console.log` suelto.
- **Por qué lo necesito.** En producción no leo logs a ojo: los mando a una herramienta y busco
  "todos los logs del `requestId` X" o "todos los `statusCode: 500`". Solo se puede si es estructurado.
- **En mi código.** `nestjs-pino` en `app.module.ts`:
  - dev → `pino-pretty` (legible con colores); prod → JSON puro.
  - a cada request le asigna un `requestId` único (o respeta el `x-request-id` entrante).
- **Concepto clave.** `requestId` = "número de seguimiento" para correlacionar todos los logs
  de una misma petición aunque haya muchas concurrentes.

### 5. Filtro global de excepciones

- **Qué es.** Un único lugar que atrapa **cualquier** error y lo transforma en una respuesta
  HTTP uniforme y prolija.
- **Por qué lo necesito.** Sin esto, un error de Prisma se iría como un 500 feo con stack trace,
  y cada endpoint devolvería errores con forma distinta → el frontend no sabe qué esperar.
- **En mi código.** `src/common/filters/all-exceptions.filter.ts`. Forma uniforme:
  `{ statusCode, message, error, path, timestamp, requestId }`. Traducciones:
  - Prisma `P2002` (único duplicado) → **409**
  - Prisma `P2025` (no encontrado) → **404**
  - `P2003` (FK) → **400**
  - `ZodError` → **400**
  - `23P01` (exclusion / doble-booking, Fase 5) → **409**
  - `TenantContextMissingError` → **500** (bug del server)
  - Loguea 5xx como `error`, 4xx como `warn`.
- **Concepto clave.** "Traducir errores técnicos a códigos HTTP correctos" en un solo punto.

### 6. Swagger (OpenAPI)

- **Qué es.** Documentación **interactiva y automática** de la API, servida en `/api`.
- **Por qué lo necesito.** El frontend (`../agendapp-front`) necesita saber qué endpoints hay
  y qué reciben/devuelven. Swagger lo genera del código y da un botón "probar".
- **En mi código.** `main.ts`, `DocumentBuilder` + `addBearerAuth()` (casillero para el JWT futuro).
- **Concepto clave.** Es "el menú del restaurante" de la API, siempre actualizado.

### 7. Validación global (`ValidationPipe` + class-validator)

- **Qué es.** Regla de oro: **nunca confiar en lo que manda el cliente.** Cada endpoint declara
  un DTO con decoradores (`@IsEmail()`, `@Min(0)`) y Nest valida el body automáticamente.
- **Por qué lo necesito.** Los datos vienen de afuera: email inválido, precio negativo, fecha
  mal formada → hay que rechazarlos antes de tocarlos.
- **En mi código.** `main.ts`, `ValidationPipe` con:
  - `whitelist: true` → descarta campos no declarados (ej. `isAdmin` de contrabando).
  - `forbidNonWhitelisted: true` → si mandan un campo extra, rechaza con 400.
  - `transform: true` → convierte el JSON plano en la clase DTO con tipos correctos.
- **Concepto clave.** Es la "aduana" de la API: nada entra sin declararse y pasar el escáner.

### 8. Throttling (rate limiting)

- **Qué es.** Limitar cuántas peticiones puede hacer un cliente por unidad de tiempo.
- **Por qué lo necesito.** Sin esto, se puede hacer fuerza bruta a `/auth/login` o saturar el
  servidor (DoS). Crítico en el portal público (Fase 7), donde cualquiera anónimo pega a la API.
- **En mi código.** `app.module.ts`, dos ventanas + `ThrottlerGuard` global:
  - `short`: 10 req/segundo (frena ráfagas).
  - `long`: 100 req/minuto (frena abuso sostenido).
- **Concepto clave.** Dos límites complementarios: uno de ráfaga, uno sostenido.

### 9. Config con Zod (validación de entorno)

- **Qué es.** Las variables de entorno (`DATABASE_URL`, `PORT`) se validan **al arrancar** con
  un schema de Zod.
- **Por qué lo necesito.** "Fail fast": si falta o está mal `DATABASE_URL`, la app **ni arranca**
  y me dice exactamente qué falta, en vez de explotar en la primera query.
- **En mi código.** `src/config/env.schema.ts` + `env.validation.ts`, cableado en
  `ConfigModule.forRoot({ validate: validateEnv })`. Acceso tipado: `config.get('PORT', { infer: true })`
  devuelve `number`.
- **Concepto clave.** Es el "checklist pre-vuelo": si falta combustible, el avión no despega.

---

## 🔗 Cómo encajan todos (el recorrido de un request)

Cuando en Fase 1+ llegue un request real:

```
Config validada (9) arrancó la app
   → Rate limiting (8) lo deja pasar
   → Validación (7) revisa el body
   → El JWT llena la mochila del tenant (2)
   → El service usa prisma.scoped (3): inyecta tenantId + esconde borrados
   → Todo queda logueado con requestId (4)
   → Si algo falla, el filtro de excepciones (5) devuelve un error prolijo
Swagger (6) documenta todo · los UUID (1) identifican cada fila
```

---

## 📝 Autoevaluación (para practicar explicándolo)

1. ¿Por qué UUID y no IDs autoincrementales en un SaaS multi-tenant?
2. ¿Qué problema resuelve `AsyncLocalStorage` que no resolvería pasar `tenantId` por parámetro?
3. ¿Cuál es la diferencia entre `prisma.scoped.customer` y `prisma.customer`? ¿Cuándo uso cada uno?
4. Si "borro" un cliente, ¿qué pasa realmente en la base? ¿Qué hace la extension?
5. ¿Qué significan los 3 estados del tenant-context (`run`, `runWithoutTenant`, `undefined`)?
6. Un `P2002` de Prisma, ¿en qué código HTTP se traduce y por qué?
7. ¿Para qué sirve el `requestId` en los logs?
8. ¿Qué hace `whitelist` vs `forbidNonWhitelisted` en el `ValidationPipe`?
9. ¿Por qué la app no debería arrancar si falta `DATABASE_URL`?
10. ¿Cuál es el único "hueco" consciente de la Fase 0 y cuándo se completa?

---

<!-- ================================================================= -->
<!-- PLANTILLA PARA LAS PRÓXIMAS FASES — copiá este bloque al avanzar   -->
<!-- ================================================================= -->

<!--
## 🧱 Fase N: <título>

### ¿Qué construí?
(resumen en 2-3 líneas)

### Modelos / migraciones nuevas
- ...

### Conceptos / decisiones clave
- **<tema>** — qué es · por qué · en mi código (`ruta/archivo.ts`).

### Cómo se conecta con los cimientos de Fase 0
- ...

### Autoevaluación
1. ...
-->
