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
plan `avanzado`) con 2 sucursales con horario, 1 feriado, 3 empleados, un
catálogo cargado (2 categorías, 2 servicios, 2 recursos), 3 clientas con 2
etiquetas y 4 turnos en la semana que viene:

| Email | Rol | Estado |
|---|---|---|
| `dueno@demo.test` | `OWNER` | activo |
| `profesional@demo.test` | `PROFESSIONAL` | activo, con turno partido y una ausencia |
| `invitada@demo.test` | `ADMINISTRATIVE` | **pendiente** de activación |

Contraseña de los activos: `demo1234`. El seed imprime el link de activación de
la empleada pendiente, útil para probar esa pantalla.

Los teléfonos de las tres clientas están escritos de tres formas distintas a
propósito (`+54 9 11 4123-5566`, `(011) 4777-8899`, `11 5030-2211`): es lo que
pasa en la vida real y sirve para probar que la búsqueda los encuentra igual.

Los turnos se ubican **relativos a hoy** (el próximo lunes y miércoles, que es
cuando Lucía atiende en Centro), así la agenda siempre tiene algo aunque el seed
se corra en otra fecha. Hay uno esperando seña y uno cancelado, para ver los dos
estados en pantalla.

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
  "error": "BAD_REQUEST",
  "path": "/auth/register",
  "timestamp": "2026-08-13T14:30:00.000Z",
  "requestId": "a1b2c3d4-..."
}
```

**Ramificar por `statusCode`, nunca por `error`.** El `error` es una etiqueta para
mirar en un log, y su forma no es estable: según de dónde venga el error puede
llegar como `"NOT_FOUND"` o como `"Not Found"`. El `statusCode` sí es confiable.

**`message` puede ser un string o un array de strings.** Los errores de validación
devuelven un array con un mensaje por campo inválido. El helper que muestra
errores tiene que contemplar los dos casos o va a renderizar `[object Object]`.

Los mensajes de validación están **en español** y son aptos para mostrarle al
usuario tal cual.

El `requestId` aparece también en los logs del backend: si algo falla, ese id
permite encontrar la request exacta.

**Algunos errores traen campos extra** además de los seis de arriba, cuando el
front necesita ese dato para reaccionar. Hoy el único es el 409 de
`POST /customers`, que suma `existingCustomer` con la ficha ya cargada. Los seis
campos base están siempre; los extra se documentan en el endpoint que los usa.

### Códigos

| Código | Significado |
|---|---|
| 400 | Datos inválidos. `message` suele ser un array. |
| 401 | Falta el token o venció → disparar el refresh. |
| 403 | El rol no alcanza. Reintentar no sirve. |
| 404 | No existe, o pertenece a otro tenant (son indistinguibles a propósito). |
| 409 | Conflicto: nombre duplicado, solapamiento de horario, teléfono de cliente repetido. |
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

**Disponible — 80 endpoints:**

| Área | Endpoints | Alcanza para |
|---|---|---|
| `/auth` | 10 | Toda la capa de sesión: registro, login, refresh, logout, perfil, cambio de contraseña, **recuperar la contraseña olvidada y confirmar el email** |
| `/tenants` | 6 | Configuración del negocio, branding (colores y logo), preferencias |
| `/branches` | 11 | CRUD de sucursales, horario semanal, feriados y días especiales |
| `/employees` | 13 | CRUD, invitación con link, activación pública, permisos, asignación a sucursales, horario con turno partido, ausencias |
| `/service-categories` | 5 | CRUD de categorías del catálogo |
| `/services` | 9 | CRUD de servicios, quién los presta y dónde, qué recursos requieren |
| `/resources` | 5 | CRUD de camillas, salas y sillones por sucursal |
| `/customers` | 7 | CRUD de clientes, búsqueda paginada, etiquetas de cada uno |
| `/customer-tags` | 5 | CRUD de etiquetas ("VIP", "Debe seña") |
| `/appointments` | 8 | Disponibilidad, agendar, agenda por rango, estados, reprogramar, series |
| `/health` | 1 | Healthcheck |

**Todavía no existe:**

- Pagos y cobro de señas (Fase 6)
- Portal público de reservas (Fase 7)

No conviene diseñar contra estos: el contrato todavía no está definido y va a
cambiar.

### Detalle sobre el catálogo (Fase 3)

Tres cosas que conviene saber antes de armar la pantalla:

**El precio va en centavos, `Int`.** `priceCents: 1500000` son $15.000. Lo mismo
`depositAmountCents` (la seña, `null` = el servicio no pide seña). La seña no
puede superar al precio, ni siquiera indirectamente: bajar el precio por debajo
de una seña ya cargada devuelve 400. Si el usuario baja el precio, mandá los dos
campos juntos.

**Un servicio se presta en una sucursal concreta, por una persona concreta.**
`PUT /services/:id/employees` recibe `{ assignments: [{ employeeId, branchId }] }`
y reemplaza la lista completa. Cada par se valida contra las sucursales del
empleado: si no trabaja ahí, es 400. O sea que el selector de "quién presta este
servicio" tiene que dejar elegir **persona + sucursal**, no solo persona. En el
seed, Lucía hace corte en las dos sucursales pero color solo en Centro — sirve
para probar ese caso.

**Los recursos (camillas, salas) son feature de plan.** Con el plan Básico,
`POST /resources` devuelve 403 con un mensaje explicando que hay que cambiar de
plan; conviene mostrarlo tal cual. El gate corre solo en el alta: si un negocio
baja de plan, sigue viendo y editando lo que ya tenía cargado. El nombre del
recurso es único **por sucursal**, así que "Camilla 1" puede existir en Centro y
en Palermo.

Detalles menores: el `color` del servicio es `#RRGGBB` y va directo al calendario;
`durationMinutes` va de 1 a 1440; las categorías se ordenan por `displayOrder` y,
a igual valor, alfabéticamente; dar de baja una categoría **no** borra sus
servicios, los deja con `category: null`.

### Detalle sobre los clientes (Fase 4)

**Un teléfono, un cliente.** El teléfono es lo que identifica a una persona, no
el nombre. Si `POST /customers` recibe uno que ya está cargado en el negocio,
responde **409 y no crea nada** — pero el cuerpo trae la ficha existente:

```jsonc
{
  "statusCode": 409,
  "message": "Ya tenés un cliente con ese teléfono",
  "error": "Conflict",
  "existingCustomer": { "id": "...", "firstName": "María", "lastName": "González", ... }
}
```

Con eso alcanza para mostrar *"Ya existe María González con ese teléfono — ¿es
esta persona?"* y ofrecer abrir su ficha, sin ir a buscarla con otra request.
**No hay merge automático a propósito:** dos personas pueden compartir teléfono
(una madre y su hija, una pareja), y unir dos historiales es una decisión de
quien está atendiendo. `PATCH /customers/:id` pasa por el mismo chequeo, así que
cambiar un teléfono a uno ya usado también da 409.

**El teléfono se compara normalizado.** El backend guarda lo que el usuario
tipeó y lo muestra tal cual, pero compara solo los dígitos (los últimos 10). O
sea que `+54 9 11 5555-1234`, `011 5555-1234` y `(011) 5555.1234` son la misma
persona, tanto para detectar duplicados como para buscar. **No hace falta
normalizar nada en el front.** El único formato que todavía no se empareja es el
`15` viejo (`011 15 5555-1234`).

**La búsqueda es una sola caja.** `GET /customers?search=...` cruza nombre,
apellido, email y teléfono a la vez, así que no hacen falta filtros separados. Si
se escriben varias palabras, todas tienen que aparecer en el nombre completo, en
cualquier orden: `maría gonzález` y `gonzález maría` encuentran lo mismo.

**Es el primer endpoint paginado de la API.** La respuesta no es un array suelto:

```jsonc
{
  "data": [ /* ...clientes... */ ],
  "meta": { "page": 1, "pageSize": 20, "total": 137, "totalPages": 7 }
}
```

`page` arranca en 1. `pageSize` va de 1 a 100 (por defecto 20; pedir más da 400).
Pedir una página más allá del final devuelve `data: []` con el `meta` correcto,
no un 404. **Esta forma se va a repetir en el historial de turnos y de pagos**,
así que conviene resolverla una sola vez.

**Permisos:** cargar y editar clientes lo puede hacer cualquier empleado — quien
atiende el mostrador no siempre es administrativo. **Dar de baja** un cliente y
**administrar las etiquetas** sí son `OWNER` / `ADMINISTRATIVE`.

Detalles menores: el apellido, el email, la fecha de nacimiento y las notas son
opcionales; solo nombre y teléfono son obligatorios. El email **no** es único
(dos clientes pueden compartir casilla). `dateOfBirth` es `"YYYY-MM-DD"`, no
puede ser futura. `PUT /customers/:id/tags` reemplaza el set completo (`[]` las
saca todas). Cada etiqueta trae `customerCount`, útil para avisar antes de
borrarla; dar de baja una etiqueta la saca de todos los clientes. Dar de baja un
cliente **libera su teléfono** para una ficha nueva.

### Detalle sobre los turnos (Fase 5)

Es la parte más grande de la API y la que reemplaza el mock de la agenda.

**Primero mirar los huecos libres.**
`GET /appointments/availability?branchId=&serviceId=&date=YYYY-MM-DD` devuelve
los slots reservables de ese día. Ya tiene restado todo: horario del local,
horario del profesional, ausencias, turnos tomados y recursos ocupados.

```jsonc
{
  "date": "2026-09-07",
  "timezone": "America/Argentina/Buenos_Aires",
  "durationMinutes": 45,
  "bufferAfterMinutes": 10,
  "branchClosed": false,
  "slots": [
    {
      "startsAt": "2026-09-07T12:00:00.000Z",
      "endsAt": "2026-09-07T12:55:00.000Z",
      "employees": [{ "employeeId": "...", "employeeName": "Lucía Fernández" }]
    }
  ]
}
```

Cuatro cosas que evitan sorpresas:

1. **Los slots duran `duración + buffer`.** El buffer es tiempo en el que el
   profesional sigue ocupado, así que forma parte de lo que el turno reserva. La
   consecuencia visible es que el último turno del día **termina antes del
   cierre**, no justo al cierre. No es un bug.
2. **Sin `employeeId` responden todos los que prestan ese servicio ahí**, y cada
   slot dice quiénes lo tienen libre. Con `employeeId` se filtra a uno.
3. **`branchClosed` distingue "cerrado" de "sin lugar".** Los dos casos
   devuelven `slots: []`, pero el cartel que corresponde es distinto.
4. **No recorta los slots que ya pasaron.** Describe lo que el horario permite,
   no lo que todavía se puede reservar. Una pantalla de reserva tiene que
   filtrar por `startsAt > ahora`.

**Agendar no obliga a usar un slot de esa lista.**
`POST /appointments` acepta cualquier `startsAt` que **entre** en el tiempo libre
del profesional. O sea que se puede cargar un turno a las 09:07 para alguien que
llegó sin turno. El `endsAt` lo calcula el servidor sumando duración y buffer de
cada servicio: no hay que mandarlo.

**El precio y la duración se congelan.** `appointment.services[]` guarda lo que
el servicio valía y duraba **cuando se reservó**. Si el negocio cambia la lista
de precios, los turnos viejos no se mueven — para mostrar el precio de un turno,
usar `totalPriceCents` del turno, nunca el del servicio.

⚠️ **El 409 al agendar es normal, no un error de la app.** Si dos personas
reservan el mismo hueco a la vez, una lo consigue y la otra recibe 409 con un
mensaje que dice qué se pisó (la agenda del profesional o un recurso). Lo
correcto es refrescar la disponibilidad y ofrecer otro horario, no reintentar.

**La agenda va por rango, no paginada.**
`GET /appointments?from=2026-09-07&to=2026-09-13` — inclusive, en días del
calendario del negocio, hasta 92 días. Filtros opcionales: `branchId`,
`employeeId`, `customerId`, `status` (repetible). Un turno que arranca el día
anterior y termina dentro del rango también viene.

**Los estados tienen un camino fijo.**
`PATCH /appointments/:id/status`:

| Desde | Puede pasar a |
|---|---|
| `PENDING_PAYMENT` | `CONFIRMED`, cancelado |
| `CONFIRMED` | `ATTENDED`, `NO_SHOW`, cancelado |
| el resto | nada: son finales |

Una transición inválida da **409**, no 400. Al cancelar, la respuesta trae
`refund` con qué corresponde devolver según la política del negocio — **no mueve
plata**, eso llega con los pagos (Fase 6), pero sirve para decirle algo concreto
a la clienta en el momento:

```jsonc
{
  "appointment": { /* ... */ },
  "refund": { "type": "FULL", "amountCents": 30000, "withinPolicy": true,
              "reason": "Canceló en término: corresponde devolver la seña completa" }
}
```

`refund` es `null` en los cambios que no son cancelación.

**Reprogramar crea un turno nuevo.**
`POST /appointments/:id/reschedule` devuelve **el turno nuevo** (201). El viejo
queda en `RESCHEDULED` y los dos quedan enlazados por `rescheduledFromId` /
`rescheduledToId`. No se edita el original a propósito: así el historial dice
que hubo un cambio. Los servicios se copian con el precio que tenían.

**Las series repiten hora de pared.**
`POST /appointments/recurring` con `frequency` (`WEEKLY` / `BIWEEKLY` /
`MONTHLY`) y `occurrences` (1 a 52, **contando el primero**). "Los lunes a las
10" siguen siendo las 10 aunque en el medio cambie el horario de verano.

⚠️ **Las fechas que no entran se saltean, no cancelan la serie.** La respuesta
trae `created` con los que sí y `skipped` con los que no, cada uno con su
motivo. **Hay que mostrar `skipped`**: son las fechas que alguien tiene que
resolver a mano. Si no entró ninguna, ahí sí es 409.

Detalles menores: `PATCH /appointments/:id` solo edita `notes` — mover el
horario es reprogramar. Un turno puede tener varios servicios seguidos con el
mismo profesional (`serviceIds`), y la duración es la suma de todos con sus
buffers. `NO_SHOW` **ocupa la agenda igual** que un turno atendido: esa hora
estuvo tomada.

### Detalle sobre la invitación de empleados

Ahora **el link se manda por mail solo**. `POST /employees` igual lo sigue
devolviendo en `activationUrl`, y eso es a propósito y definitivo: la respuesta
trae también `emailSent`, y cuando viene en `false` el alta se hizo pero el mail
no salió. Ahí es donde la UI tiene que mostrar el link para copiar. Cuando viene
en `true`, alcanza con decir "le mandamos un mail a ana@…".

`POST /employees/activate` es público y es donde el empleado define su contraseña.
La pantalla que lo recibe es `/activar?token=…`.

### Tres pantallas nuevas que hay que construir

Los mails ya salen, y los links que mandan apuntan al front. Son rutas que
todavía no existen:

| Ruta | Qué recibe | Qué hace |
|---|---|---|
| `/activar?token=` | Invitación de empleado | Pide contraseña → `POST /employees/activate` |
| `/restablecer?token=` | Reset de contraseña | Pide contraseña nueva → `POST /auth/reset-password` |
| `/verificar-email?token=` | Verificación de email | Llama sola a `POST /auth/verify-email` y muestra el resultado |

Las tres reciben el token por query string, las tres son **públicas** (sin
sesión) y las tres devuelven **400 con un mensaje ya escrito en castellano** si
el link no sirve: mostralo tal cual. El token vale **una sola vez** — si el
usuario recarga la página después de completar, el segundo intento da 400, así
que conviene redirigir apenas sale bien en vez de dejarlo en la pantalla.

**`POST /auth/forgot-password` siempre devuelve 204**, exista o no la cuenta.
No es un detalle de implementación: la UI **no puede** decir "ese email no está
registrado", porque justamente lo que se evita es que cualquiera averigüe qué
emails tienen cuenta. El mensaje correcto es del tipo "si esa dirección tiene
una cuenta, te mandamos el link". Pedirlo de nuevo invalida el link anterior.

**Después de un reset, todas las sesiones se cierran.** El refresh token que
tuviera guardado deja de servir: hay que mandar al login, no intentar refrescar.

**`emailVerifiedAt`** viene en `GET /auth/me` dentro de `user`. En `null` = sin
confirmar, y ahí tiene sentido un cartel con "reenviar" que llame a
`POST /auth/verify-email/resend`. Hoy **no bloquea nada**: es informativo. Si ya
estaba confirmado, el reenvío devuelve 409.

**En desarrollo no sale ningún mail.** Con `MAIL_PROVIDER=log` (el default) el
back escribe el link en su propia consola en vez de mandarlo. Para probar estas
pantallas, el link se copia de ahí.

---

## Referencia visual

Handoff con el detalle de cada endpoint, request y response:
<https://claude.ai/code/artifact/8811087c-7075-43ac-8d5a-aece46ec26af>
