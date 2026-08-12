# 📚 Bitácora de aprendizaje — Fase 1: Auth y Tenant base

> **Para qué sirve este archivo.** Igual que el de la Fase 0: es mi guía de estudio.
> Acá está lo que construí en la Fase 1 y —sobre todo— **por qué** cada decisión, para
> poder explicarlo en voz alta.
>
> Complementa a:
> - [`fase-0-cimientos.md`](./fase-0-cimientos.md) — los cimientos que esta fase usa.
> - [`../development-roadmap.md`](../development-roadmap.md) — el plan fase por fase.
> - [`../database-reference.md`](../database-reference.md) — el modelo de datos.

---

## 🎯 ¿Qué es la Fase 1?

La Fase 0 dejó el andamiaje sin nadie que lo use. **La Fase 1 puso los primeros datos
reales y la puerta de entrada al sistema**: una persona se registra, recibe un token y
desde ahí todo lo que pida queda automáticamente encerrado dentro de su negocio.

Es la fase donde el multi-tenancy deja de ser teoría: se completó el hueco consciente que
había quedado (el middleware que llena la "mochila" del tenant) y recién ahí
`prisma.scoped` empezó a servir para algo.

**Estado al terminar:**

- ✅ 8 modelos en la base (auth, planes, negocio, empleado mínimo).
- ✅ Registro, login, refresh, logout, `/auth/me`, cambio de contraseña.
- ✅ Guard de JWT global + `@Public()` + autorización por rol.
- ✅ Endpoints de configuración del negocio (`/tenants/me` y sus dos sub-recursos).
- ✅ 45 tests e2e contra Postgres real + 42 unitarios.
- ⏭️ Diferido a propósito: emails (reset de contraseña, verificación) — antes de la Fase 7.

---

## 🗃️ Modelos y migración

Una sola migración: `20260805175327_auth_and_tenant_base`.

| Modelo | Para qué |
|---|---|
| `User` | la cuenta con la que alguien se logea (dueño o empleado) |
| `RefreshToken` | sesiones largas, con rotación |
| `Plan` | catálogo global de planes (Básico, Pro, Avanzado, Empresa) |
| `Tenant` | el negocio |
| `Subscription` | historial de suscripciones del negocio |
| `TenantBranding` | personalización del portal público (Fase 7) |
| `TenantSettings` | configuración operativa (política de cancelación, buffer) |
| `Employee` | versión mínima; se completa en la Fase 2 |

**Dos cosas que no se ven en el `schema.prisma`:** después de generar la migración la
edité a mano para agregar SQL que Prisma no sabe generar — el índice parcial de "un solo
owner activo por negocio" y los CHECK constraints de coherencia. Si toco esas tablas,
tengo que mirar el `.sql`, no solo el schema.

---

## 🧠 Conceptos y decisiones clave

### 1. El registro es una transacción, no seis inserts

- **Qué es.** `POST /auth/register` crea **en un solo `prisma.$transaction`**: `User` +
  `Tenant` + `Employee` (el owner) + `Subscription` (trial) + `TenantBranding` +
  `TenantSettings`.
- **Por qué.** Si fallara a la mitad quedaría un usuario sin negocio, o un negocio sin
  configuración, y el resto del sistema tendría que preguntarse en cada query "¿y si no
  existe?". Con la transacción: **o queda todo, o no queda nada**.
- **En mi código.** `src/modules/auth/auth.service.ts` → `register()`.
- **Concepto clave.** Atomicidad: la unidad de trabajo es el negocio completo, no la fila.

### 2. El dueño es un empleado más

- **Qué es.** No hay tabla de "dueños": el owner es una fila de `employees` con
  `is_owner = true` y `role = owner`.
- **Por qué.** El dueño también atiende turnos, tiene horarios y cuenta para el límite de
  empleados del plan. Modelarlo aparte sería duplicar todo eso.
- **Concepto clave.** Preferir un flag sobre una jerarquía de tablas cuando el
  comportamiento es el mismo.

### 3. Contraseñas con argon2 (nunca en texto plano)

- **Qué es.** La contraseña se guarda como **hash** argon2 en `password_hash`. Al loguear
  se hashea lo que llega y se compara.
- **Por qué.** Un hash no se puede revertir: si alguien se roba la base, no se lleva las
  contraseñas. argon2 además es **lento a propósito** y usa memoria, lo que encarece la
  fuerza bruta.
- **Concepto clave.** Hashing ≠ encriptación: el hash es de una sola vía, no hay
  "desencriptar".

### 4. El refresh token NO es un JWT (y por qué)

- **Qué es.** Hay dos tokens:
  - **Access token** (JWT, 15 min): firmado, lo lee cualquiera que lo tenga, sirve para
    entrar a los endpoints.
  - **Refresh token** (7 días): un string **opaco** con forma `<id>.<secret>` que vive en
    la tabla `refresh_tokens` con el `secret` hasheado con argon2.
- **Por qué así.** Un JWT no se puede revocar: mientras no expire, vale. Para el token de
  vida larga necesito poder **matarlo**, así que va a la base. El formato `<id>.<secret>`
  existe porque un hash con salt no se puede buscar por igualdad: el `id` ubica la fila y
  el `secret` se verifica contra el hash.
- **Rotación + detección de reuso.** Cada refresh revoca el token viejo y emite uno nuevo
  con el mismo `family_id`. Si alguna vez llega un token **ya revocado**, es señal de robo
  (alguien está usando una copia vieja) → se revoca **toda la familia** y ambas partes
  quedan afuera.
- **En mi código.** `src/modules/auth/refresh-token.service.ts`.
- **Concepto clave.** Token corto y verificable vs. token largo y revocable: cada uno paga
  un precio distinto.

### 5. Los permisos se releen de la base en cada request

- **Qué es.** `JwtStrategy.validate` no confía en lo que dice el token: busca al empleado
  en la base (activo, no borrado, negocio no borrado) y arma el usuario desde ahí.
- **Por qué.** Si despido a alguien o le bajo el rol, con un token de 15 minutos seguiría
  entrando hasta que expire. Releyendo, pierde el acceso **en el acto**. El costo es una
  query por request contra índices únicos.
- **Concepto clave.** El token dice "quién decís que sos"; la base dice "qué podés hacer
  ahora".

### 6. La mochila del tenant, completada (lo más importante de la fase)

Esto es lo que cerró el hueco de la Fase 0. Son tres piezas en orden:

```
request
  → TenantContextMiddleware   monta la mochila VACÍA (als.run)
  → ThrottlerGuard            ¿pasaste el rate limit?
  → JwtAuthGuard              valida el token y PONE el tenant en la mochila (set)
  → RolesGuard                ¿tu rol alcanza para este endpoint?
  → handler + service         prisma.scoped filtra solo
```

- **Por qué middleware y no interceptor/guard para montarla.** El middleware es lo primero
  que corre, y como llama a `next()` **dentro** de `als.run(...)`, todo lo que viene
  después queda en el mismo contexto asincrónico. Un interceptor llegaría tarde para
  algunas cosas y sería más frágil.
- **Pero entonces, ¿de dónde saca el tenant?** De ningún lado: **cuando corre el
  middleware todavía no pasó el guard**, así que no existe `request.user`. Por eso la
  mochila nace vacía y el guard la completa mutando el mismo objeto.
- **Eso agregó un tercer estado** al tenant-context:

  | Estado | Cuándo | Qué hace la extension |
  |---|---|---|
  | resuelto | request autenticado | inyecta `tenantId` |
  | `null` | `runWithoutTenant()` | passthrough (escape hatch) |
  | **sin resolver** | ruta `@Public()` o sin auth | **lanza error 500** |
  | no montado | fuera de un request (job, script) | lanza error 500 |

- **Concepto clave.** El diseño falla **ruidoso**: si el contexto no se resolvió, la query
  explota. Nunca se degrada a "consulta sin filtro", que sería una fuga de datos silenciosa
  entre negocios.

### 7. Todo endpoint nace cerrado

- **Qué es.** El `JwtAuthGuard` es global (`APP_GUARD`): protege todo. Para abrir algo hay
  que marcarlo con `@Public()`.
- **Por qué.** Es la diferencia entre "me olvidé de proteger un endpoint" (fuga) y "me
  olvidé de abrir un endpoint" (error visible, alguien se queja al toque). El default
  siempre tiene que ser el seguro.
- **Quiénes son públicos hoy.** `/health`, `register`, `login`, `refresh` y `logout`.
  `logout` es público a propósito: alcanza con presentar el refresh token, así puedo cerrar
  sesión aunque el access token ya haya vencido.
- **Concepto clave.** "Secure by default": la seguridad no puede depender de acordarse.

### 8. Autenticación ≠ autorización

- **Qué es.** El `JwtAuthGuard` responde **quién sos**. El `RolesGuard` + `@Roles(...)`
  responde **qué podés hacer**.
- **Por qué lo agregué.** Sin esto, cualquier empleado con rol `professional` podía
  renombrar el negocio o cambiar la política de cancelación. Leer la configuración la puede
  cualquiera; editarla, solo `OWNER` y `ADMINISTRATIVE`.
- **Detalle de implementación.** El guard no hace nada si el endpoint no declara `@Roles`,
  así que el default sigue siendo "alcanza con estar autenticado".
- **Concepto clave.** Son dos preguntas distintas y se resuelven en dos lugares distintos.

### 9. PATCH: ausente vs. `null`

- **Qué es.** En los endpoints de edición, **no mandar un campo** significa "no lo toques",
  y mandarlo en `null` significa "borralo".
- **Por qué importa.** Sin esa distinción no hay forma de borrar el logo o la descripción
  del negocio: mandar `null` se confundiría con "no lo mandé".
- **En mi código.** El service arma el objeto de update filtrando solo los `undefined`
  (`pickDefined` en `tenants.service.ts`).
- **Concepto clave.** En un PATCH, la ausencia de un campo **es** información.

### 10. Los tests e2e prueban la app, no una imitación

- **Qué es.** Los e2e levantan la aplicación entera —mismos guards, mismo
  `ValidationPipe`, mismo filtro de errores— y le pegan por HTTP con supertest,
  contra un Postgres de verdad.
- **Por qué contra una base real.** Los mocks de Prisma prueban que mi código
  llama bien a Prisma; no prueban que la base haga lo que espero. Los CHECK
  constraints, el índice de owner único y —sobre todo— el filtro por tenant que
  inyecta la extension solo se ven contra Postgres.
- **La base de tests es aparte** (`agendapp_test`): se crea, migra y siembra sola
  antes de la corrida, y los tests truncan las tablas entre casos. Así puedo
  borrar todo sin perder los datos con los que vengo probando a mano en dev.
- **Un cambio que hubo que hacer primero:** el `ValidationPipe` y el filtro de
  excepciones estaban en `main.ts`, que los tests no ejecutan. Pasaron a ser
  providers (`APP_PIPE` / `APP_FILTER`) en `AppModule`, así la app de test es la
  misma que la de producción y no una parecida.
- **Concepto clave.** Un test e2e que corre sobre una app distinta a la real
  prueba otra cosa. Si el bootstrap configura algo, los tests no lo tienen.

### 11. Las PrismaPromise son perezosas (esto me lo enseñó un test que fallaba)

- **Qué pasó.** Escribí `ctx.runWithoutTenant(() => prisma.scoped.tenantSettings.findMany())`
  y explotó con `TenantContextMissingError`, justo dentro del escape hatch que
  debería evitarlo.
- **Por qué.** Una `PrismaPromise` **no ejecuta nada al crearse**: la query
  arranca cuando alguien llama a su `.then()`. Como el callback devolvía la
  promesa sin esperarla, `runWithoutTenant` terminaba, se desmontaba el
  `AsyncLocalStorage`, y recién ahí Jest hacía el `await` → la query corría sin
  contexto.
- **La forma correcta.** `async () => await prisma.scoped.tenantSettings.findMany()`:
  el `await` dispara la query **adentro** del contexto.
- **Dónde importa.** Solo en código que monta el contexto a mano (jobs, seeds,
  webhooks de las fases 6 y 8). En un request HTTP normal el middleware envuelve
  todo el ciclo, así que no hay forma de escaparse.
- **Concepto clave.** "Lazy" no es un detalle de performance: cambia *cuándo*
  corre el código, y con `AsyncLocalStorage` el cuándo define el contexto.

### 12. El slug no se edita (todavía)

- **Qué es.** El `slug` (`peluqueria-ana`) se genera del nombre al registrarse y no está
  entre los campos editables.
- **Por qué.** Es la URL pública del portal de reservas (Fase 7). Cambiarlo rompe todos los
  links que el negocio ya haya compartido. Cuando haga falta, va a ser un endpoint aparte
  que valide slugs reservados, duplicados y deje un redirect del viejo.
- **Concepto clave.** Un identificador público es un contrato con el mundo exterior; no se
  cambia de taquito.

---

## 🔗 Cómo se conecta con los cimientos de la Fase 0

| Cimiento de Fase 0 | Cómo lo usa la Fase 1 |
|---|---|
| UUID + `pgcrypto` | todas las tablas nuevas usan `gen_random_uuid()` |
| Tenant context (ALS) | **completado**: middleware + guard lo llenan en cada request |
| Extensions de Prisma | `TenantsService` lee y escribe sin poner `tenantId` a mano |
| Logs con `requestId` | cada login/registro queda correlacionado |
| Filtro de excepciones | `P2025` → 404, `TenantContextMissingError` → 500 |
| Swagger | los DTOs nuevos están anotados; `Authorize` acepta el bearer |
| `ValidationPipe` | rechaza campos de contrabando (mandar `slug` da 400) |
| Throttling | límite extra de 5/min en los endpoints con credenciales |
| Config con Zod | `JWT_SECRET`, `JWT_ACCESS_EXPIRES_IN`, `REFRESH_TOKEN_TTL_DAYS`, `TRIAL_DAYS` |

---

## 📝 Autoevaluación

1. ¿Por qué el registro tiene que ser una transacción? ¿Qué pasaría sin ella?
2. ¿Por qué el refresh token no es un JWT? ¿Qué gano y qué pierdo?
3. ¿Qué es la "detección de reuso" y qué hace el sistema cuando la detecta?
4. Si a un empleado lo desactivo, ¿cuánto tarda en perder el acceso? ¿Por qué?
5. ¿Por qué el tenant-context se monta en un middleware y se completa en un guard, en vez
   de hacer las dos cosas en el mismo lugar?
6. ¿Qué pasa si un endpoint `@Public()` consulta `prisma.scoped`? ¿Por qué está bien que
   pase eso?
7. ¿Cuál es la diferencia entre el `JwtAuthGuard` y el `RolesGuard`?
8. ¿Por qué conviene que los endpoints nazcan protegidos y se abran de a uno?
9. En un PATCH, ¿qué diferencia hay entre no mandar `logoUrl` y mandarlo en `null`?
10. ¿Por qué los e2e corren contra una base real y no contra Prisma mockeado?
11. ¿Por qué `runWithoutTenant(() => prisma.scoped.x.findMany())` falla y con `await` no?
12. ¿Por qué el `slug` no se puede editar por ahora?

---

## ✅ Fase cerrada

Los e2e cubren el flujo completo (registro → token → `/auth/me` → editar el negocio),
la rotación de refresh con detección de reuso, el corte de acceso al desactivar un
empleado, el aislamiento entre dos negocios y la red de seguridad del tenant-scope.

Lo próximo es la **Fase 2: sucursales y empleados**, que es la primera vez que voy a
escribir un service de negocio usando `prisma.scoped` desde cero — sin acordarme del
`tenantId` en ninguna query.
