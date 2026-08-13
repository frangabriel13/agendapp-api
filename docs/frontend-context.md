# Contexto de la API para el frontend

> **Cómo usar este archivo:** copiarlo al repo del frontend como `CLAUDE.md` (o
> `docs/api-contract.md` y referenciarlo desde el `CLAUDE.md`). Describe el
> contrato de `agendapp-api` — las reglas transversales que no se deducen mirando
> un endpoint suelto.
>
> **Fuente de verdad:** el spec OpenAPI en `http://localhost:3001/api-json`. Este
> documento explica las convenciones; el spec tiene la firma exacta de cada
> endpoint. Si los dos se contradicen, gana el spec.

---

## Levantar el backend

Desde el repo `agendapp-api`:

```bash
docker compose up -d      # Postgres en :5432
npm run seed:demo         # datos de demo realistas
npm run start:dev         # API en :3001
```

- Swagger navegable: <http://localhost:3001/api>
- Spec JSON: <http://localhost:3001/api-json>
- CORS ya viene habilitado para `http://localhost:3000` (configurable con
  `CORS_ORIGINS`).

### Tipos generados

Con el server arriba, desde el repo del frontend:

```bash
npx openapi-typescript http://localhost:3001/api-json -o lib/api-types.ts
```

Regenerar cada vez que el backend agrega endpoints. Si el contrato cambia y
rompe algo, aparece como error de compilación en vez de como bug en runtime.

### Datos de demo

`npm run seed:demo` crea el tenant **Peluquería Demo** (slug `peluqueria-demo`,
plan `avanzado`) con 2 sucursales con horario, 1 feriado y 3 empleados:

| Email | Rol | Estado |
|---|---|---|
| `dueno@demo.test` | `OWNER` | activo |
| `profesional@demo.test` | `PROFESSIONAL` | activo, con turno partido y una ausencia |
| `invitada@demo.test` | `PROFESSIONAL` | **pendiente** de activación |

Contraseña de los activos: `demo1234`. El seed imprime el link de activación de
la empleada pendiente, útil para probar esa pantalla.

El seed es idempotente: borra el tenant demo anterior antes de recrearlo.

---

## Autenticación

### Flujo

`POST /auth/register` y `POST /auth/login` devuelven:

```jsonc
{
  "accessToken": "eyJhbGci...",   // JWT, va en Authorization: Bearer <token>
  "refreshToken": "4f0a1e2c-...7b.Zm9vYmFy",  // token opaco, NO es un JWT
  "tokenType": "Bearer",
  "expiresIn": 900                // segundos de vida del access token (15 min)
}
```

- El **access token** va en el header `Authorization: Bearer <token>` de cada
  request. Vive 15 minutos.
- El **refresh token** es opaco (`<id>.<secreto>`), no se puede decodificar en el
  cliente. Se manda a `POST /auth/refresh` para obtener un par nuevo.

### Rotación y detección de reuso — importante

**Cada llamada a `/auth/refresh` invalida el refresh token usado y devuelve uno
nuevo.** Hay que guardar el nuevo y descartar el viejo.

Si un refresh token ya usado se vuelve a presentar, el backend lo interpreta como
robo de credenciales y **revoca toda la familia de tokens de esa sesión**: el
usuario queda deslogueado.

Consecuencia práctica para el front: si dos requests se topan con un 401 al mismo
tiempo y ambos disparan un refresh, el segundo mata la sesión. **El interceptor
tiene que serializar los refresh**: el primero que detecta el 401 hace el refresh,
los demás esperan ese resultado y reintentan con el token nuevo.

### Quién soy

`GET /auth/me` devuelve tres bloques:

```jsonc
{
  "user":     { "id", "email", "firstName", "lastName", "phone", "emailVerifiedAt" },
  "tenant":   { "id", "businessName", "slug", "timezone", "currency", "language",
                "subscriptionStatus", "trialEndsAt" },
  "employee": { "id", "role", "isOwner" }
}
```

Es la llamada que conviene hacer al montar la app: de ahí salen el nombre del
negocio, el estado de la suscripción (para mostrar el aviso de trial por vencer) y
el rol (para decidir qué se muestra).

### Rutas públicas

Solo estas no requieren token: `/health`, `/auth/register`, `/auth/login`,
`/auth/refresh`, `/auth/logout` y `POST /employees/activate`. **Todo lo demás
responde 401 sin `Authorization`.**

### Contraseñas

Mínimo 8 caracteres, con al menos una letra y un número. Conviene replicar la
regla en el front para dar feedback inmediato, pero el backend la valida igual.

---

## Roles y permisos

```ts
type EmployeeRole = 'OWNER' | 'PROFESSIONAL' | 'ADMINISTRATIVE';
```

Las operaciones de escritura sobre sucursales y empleados exigen **`OWNER` o
`ADMINISTRATIVE`**. Un `PROFESSIONAL` puede leer, pero no crear, editar ni borrar:
recibe **403**.

Esconder los botones que el rol no puede usar es UX, no seguridad — el backend
valida siempre.

---

## Formatos de fecha y hora — la fuente de bugs más común

La API distingue **tres cosas distintas** que en JavaScript tienden a colapsar en
un solo `Date`. Mezclarlas produce bugs de desfase horario que aparecen recién
cuando cambia el huso o el horario de verano.

| Concepto | Formato | Ejemplo | Qué es |
|---|---|---|---|
| **Hora de reloj** | `"HH:MM"` | `"09:30"` | Un horario de pared, sin día ni zona. La sucursal abre a las 9:00 *localmente*. |
| **Día de calendario** | `"YYYY-MM-DD"` | `"2026-08-13"` | Un día, sin hora. Un feriado, una fecha de ingreso. |
| **Instante** | ISO 8601 con zona | `"2026-08-13T14:30:00.000Z"` | Un momento exacto en la línea de tiempo. `createdAt`, `trialEndsAt`. |

**Reglas para el front:**

1. Las horas de reloj (`opensAt`, `closesAt`, `startsAt` de un turno de empleado)
   viajan y se muestran **como string**. No convertirlas a `Date`: un
   `new Date("09:30")` no significa nada, y `new Date("1970-01-01T09:30:00Z")`
   se muestra desplazado según el huso del navegador.
2. Los días de calendario (`date` de un día especial, `hiredAt`) también son
   **strings**. `new Date("2026-08-13")` se parsea como medianoche **UTC**, así que
   en Argentina se ve como el 12 de agosto. Si hay que operar con ellos, partir el
   string o usar exclusivamente métodos UTC.
3. Solo los instantes son `Date` de verdad, y se muestran convertidos al huso del
   usuario.

El día de la semana es un entero **0 = domingo … 6 = sábado**, igual que
`Date.getDay()`.

---

## Forma de los errores

Todos los errores tienen el mismo cuerpo:

```jsonc
{
  "statusCode": 400,
  "message": "El email no tiene un formato válido",  // string O string[]
  "error": "Bad Request",
  "path": "/auth/register",
  "timestamp": "2026-08-13T14:30:00.000Z",
  "requestId": "a1b2c3d4-..."
}
```

**`message` puede ser un string o un array de strings.** Los errores de validación
devuelven un array con un mensaje por campo inválido. El helper que muestra
errores tiene que contemplar los dos casos o va a renderizar `[object Object]`.

Los mensajes de validación están **en español** y son aptos para mostrarle al
usuario tal cual.

El `requestId` aparece también en los logs del backend: si algo falla, ese id
permite encontrar la request exacta.

### Códigos

| Código | Significado |
|---|---|
| 400 | Datos inválidos. `message` suele ser un array. |
| 401 | Falta el token o venció → disparar el refresh. |
| 403 | El rol no alcanza. Reintentar no sirve. |
| 404 | No existe, o pertenece a otro tenant (son indistinguibles a propósito). |
| 409 | Conflicto: nombre duplicado, solapamiento de horario. |
| 429 | Rate limit. Ver `Retry-After`. |

---

## Validación estricta — otra fuente de bugs

El `ValidationPipe` corre con `whitelist: true` y **`forbidNonWhitelisted: true`**.

Traducido: **si el body trae una propiedad que el DTO no declara, la request falla
con 400.** No la ignora silenciosamente.

El caso típico: traer un objeto con un `GET`, modificarle un campo y hacer `PATCH`
del objeto entero. Los campos de solo lectura (`id`, `createdAt`, `updatedAt`,
`tenantId`) hacen que se rechace. **Mandar solo los campos que se editan.**

---

## Multi-tenancy: invisible para el front

El `tenantId` sale del JWT. **El front no lo manda nunca**, ni en el body, ni en la
query, ni en un header. Es más: mandarlo hace fallar la request por la regla de
arriba.

Todas las consultas quedan filtradas al tenant del usuario automáticamente. Por eso
un recurso de otro negocio da **404 y no 403**: desde la perspectiva de la sesión,
sencillamente no existe.

---

## Rate limiting

Dos ventanas generales: 10 requests por segundo y 100 por minuto. Al pasarse, **429**.

**`/auth/register`, `/auth/login` y `PATCH /auth/password` son más estrictos: 5
por minuto.** Probando el login a mano se llega al 429 enseguida — no es un bug.

Headers expuestos por CORS y legibles desde el navegador:

```
X-RateLimit-Limit-short      X-RateLimit-Remaining-short      X-RateLimit-Reset-short
X-RateLimit-Limit-long       X-RateLimit-Remaining-long       X-RateLimit-Reset-long
Retry-After
```

Notar el sufijo `-short` / `-long`: no existe un `X-RateLimit-Limit` pelado.

---

## Otras convenciones

- **IDs:** UUID v4 en string. Nunca enteros.
- **Plata:** enteros en centavos. Nunca decimales ni floats. (Aplica desde la
  Fase 3 en adelante.)
- **Borrado:** es soft delete. Un `DELETE` devuelve 204 y el recurso desaparece de
  los listados, pero no se borra físicamente.
- **`PUT` vs `PATCH`:** el `PUT` reemplaza el conjunto entero (el horario semanal
  exige los 7 días, siempre); el `PATCH` modifica solo lo que se manda.

---

## Qué existe hoy y qué no

**Disponible — 37 endpoints:**

| Área | Endpoints | Alcanza para |
|---|---|---|
| `/auth` | 6 | Toda la capa de sesión: registro, login, refresh, logout, perfil, cambio de contraseña |
| `/tenants` | 6 | Configuración del negocio, branding (colores y logo), preferencias |
| `/branches` | 11 | CRUD de sucursales, horario semanal, feriados y días especiales |
| `/employees` | 13 | CRUD, invitación con link, activación pública, permisos, asignación a sucursales, horario con turno partido, ausencias |
| `/health` | 1 | Healthcheck |

**Todavía no existe:**

- Servicios, categorías y precios (Fase 3)
- Clientes (Fase 4)
- **Turnos, disponibilidad y calendario** (Fase 5)
- Pagos (Fase 6) y portal público de reservas (Fase 7)

No conviene diseñar contra estos: el contrato todavía no está definido y va a
cambiar.

### Detalle sobre la invitación de empleados

Todavía **no se mandan emails**. `POST /employees` devuelve el link de activación
en la respuesta; hoy hay que copiarlo y pasarlo a mano. El endpoint
`POST /employees/activate` es público y es donde el empleado define su contraseña.

Cuando se implemente el envío por email (antes de la Fase 7), el link va a dejar de
venir en la respuesta. Conviene no construir UI que dependa de mostrarlo.

---

## Referencia visual

Handoff con el detalle de cada endpoint, request y response:
<https://claude.ai/code/artifact/8811087c-7075-43ac-8d5a-aece46ec26af>
