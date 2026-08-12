# 📚 Bitácora de aprendizaje — Fase 2: Sucursales y empleados

> **Para qué sirve este archivo.** Igual que los anteriores: acá está lo que construí en la
> Fase 2 y —sobre todo— **por qué** cada decisión, para poder explicarlo en voz alta.
>
> Complementa a:
> - [`fase-1-auth-y-tenant.md`](./fase-1-auth-y-tenant.md) — la fase que dejó lista la puerta de entrada.
> - [`../development-roadmap.md`](../development-roadmap.md) — el plan fase por fase.
> - [`../database-reference.md`](../database-reference.md) — el modelo de datos.

---

## 🎯 ¿Qué es la Fase 2?

La Fase 1 dejó el negocio abierto pero vacío: un dueño, una configuración y nadie más.
**La Fase 2 lo llena de estructura**: dónde se atiende (sucursales) y quién atiende
(empleados), con sus horarios.

Es también la primera fase donde escribí services de negocio **de cero usando
`prisma.scoped`**. Hasta acá el tenant-scoping era una promesa; ahora hay dos módulos
enteros donde ninguna query filtra por `tenantId` a mano y todo sigue quedando encerrado
en su negocio.

**Estado al terminar:**

- ✅ 8 modelos nuevos: sucursales con horarios y feriados, empleados con invitación,
  sucursales asignadas, horario semanal y ausencias.
- ✅ 24 endpoints nuevos (11 de sucursales + 13 de empleados).
- ✅ 132 tests e2e contra Postgres real + 167 unitarios.
- ⏭️ Diferido a propósito: mandar por mail el link de invitación (hoy vuelve en la
  respuesta). Misma deadline que el resto de los mails: antes de la Fase 7.

---

## 🗃️ Modelos y migraciones

Dos migraciones: `20260812112622_branches` y `20260812122603_employees`.

| Modelo | Para qué |
|---|---|
| `Branch` | la sucursal física |
| `BranchBusinessHour` | horario de atención, 7 filas por sucursal (una por día) |
| `BranchSpecialDay` | feriados y jornadas con horario distinto |
| `EmployeeInvitation` | link de un solo uso para que el empleado se cree la contraseña |
| `EmployeeBranch` | en qué sucursales trabaja cada uno |
| `EmployeeSchedule` | horario semanal, **una fila por tramo** |
| `EmployeeTimeOff` | vacaciones y ausencias |
| `Employee` | ya no es la versión mínima: sumó `hiredAt`, `bio`, `avatarUrl` |

Las dos migraciones se editaron a mano para sumar CHECK constraints e índices parciales.
Ya es la costumbre de este proyecto: **Prisma no sabe expresar ni CHECKs ni índices
parciales**, así que el `.sql` tiene cosas que el `schema.prisma` no muestra. Lo bueno es
que tampoco los pisa cuando genera migraciones nuevas — lo verifiqué mirando el SQL
generado antes de aplicarlo.

---

## 🧠 Conceptos y decisiones clave

### 1. Hay tres clases de "tiempo" y cada una tiene su tipo

Esto fue lo que más me ordenó la cabeza en la fase. No todo lo que parece una fecha es lo
mismo:

| Qué es | Ejemplo | Tipo en Postgres | Cómo viaja por la API |
|---|---|---|---|
| **Hora de pared** | "la sucursal abre a las 09:00" | `TIME` | `"09:00"` |
| **Día de calendario** | "el 25 de diciembre es feriado" | `DATE` | `"2026-12-25"` |
| **Instante** | "las vacaciones arrancan el 5 de enero a las 9" | `TIMESTAMPTZ` | ISO 8601 con zona |

Un horario de atención **no depende del día ni de la zona horaria**: si el negocio abre a
las 9, abre a las 9 siempre. Guardarlo como `TIMESTAMPTZ` obligaría a inventar una fecha
y arrastraría conversiones de zona que no significan nada. La zona del negocio vive una
sola vez, en `Tenant.timezone`.

Prisma no tiene un tipo "hora suelta": una columna `TIME` va y viene como `Date` anclada
al `1970-01-01` en UTC. Si eso se serializa directo a JSON, el frontend recibe
`1970-01-01T09:30:00.000Z`, que es una fecha de mentira. Por eso la conversión a `"HH:MM"`
está aislada en `src/common/utils/time-of-day.util.ts` y la API nunca expone el `Date`.

**Lo verifiqué antes de construir encima**: escribí un script chiquito que insertaba y
releía una fila para ver exactamente qué devolvía el driver. Confirmar una suposición así
cuesta cinco minutos; descubrirla mal a las tres capas de distancia cuesta una tarde.

### 2. Fechas: usar métodos UTC o la fecha se corre un día

`dateToDateOnly` usa `toISOString()`, no `getDate()`. En Buenos Aires (UTC−3),
`new Date('2026-12-25T00:00:00Z').getDate()` devuelve **24**. Ese bug es clásico y
silencioso: nadie lo nota hasta que un feriado aparece un día antes.

Y el regex `YYYY-MM-DD` no alcanza para validar: deja pasar `2026-02-30`, y JavaScript no
se queja — lo corre al 2 de marzo. Por eso el parseo hace ida y vuelta y compara: si el
string que sale no es el que entró, la fecha no existe.

### 3. La sucursal tiene 7 filas de horario; el empleado tiene una por tramo

Parecen el mismo problema pero no lo son:

- **La sucursal** abre y cierra una vez por día, así que tiene exactamente 7 filas, una
  por día, con una bandera `isClosed` para los días que no atiende.
- **El empleado** puede hacer turno partido (09:00–13:00 y 16:00–20:00), que en el rubro
  es lo más común del mundo. Con una fila por día no entra. Entonces: **una fila por
  tramo**, y un día sin filas es un día que no trabaja — no hace falta bandera.

La regla más linda de la fase: los tramos de un empleado no se pueden pisar **ni siquiera
en sucursales distintas**. La persona es una sola y no puede atender en dos lugares a la
vez. Es una regla que solo se ve si uno piensa en el mundo real y no en las tablas.

### 4. Los dos `PUT` reemplazan el set completo, y eso es a propósito

Tanto el horario de la sucursal como el del empleado se guardan borrando todo y volviendo
a insertar, dentro de una transacción. Podría haber hecho upserts fila por fila, pero:

- lo que queda guardado es **exactamente** lo que mandaron, sin restos del set anterior;
- las validaciones (que no se pisen, que estén los 7 días) se hacen sobre el conjunto
  entero, que es donde tienen sentido;
- si algo falla, no se toca nada: hay un test para eso, porque una validación que rompe
  *después* de borrar sería mucho peor que un 400.

### 5. Validar dos veces, en dos idiomas distintos

Cada regla de horario está escrita dos veces: en el service, que devuelve un 400 con un
mensaje que el frontend puede mostrar, y como CHECK constraint en Postgres, que devuelve
un error feo pero **no se puede evitar**.

No es redundancia por desconfianza del código: es que el service solo protege lo que pasa
por el service. Un seed, un job o una consulta a mano se lo saltean. La base es la última
línea. Los e2e prueban las dos capas: unos mandan un request y esperan 400; otros insertan
SQL directo y esperan que Postgres lo rechace.

### 6. Invitar a alguien sin poder mandarle un mail

El flujo del roadmap era: crear el usuario sin contraseña, mandarle un mail con un link,
que elija su clave. Pero los mails están diferidos, así que había que decidir cómo llega
ese link.

Lo que hice: **devolverlo en la respuesta de `POST /employees`**, para que el dueño se lo
pase por donde quiera. Lo importante es que **el modelo de datos no cambia**: la tabla de
tokens y el endpoint de activación ya son los definitivos. Cuando exista el proveedor de
mail, el email es un canal más y no hay nada que rehacer.

La alternativa fácil —que el dueño le ponga la contraseña al empleado— era peor: el dueño
terminaría sabiendo la clave de todo su equipo, y encima habría que rehacerlo después.

### 7. `passwordHash` nullable: el estado "existe pero todavía no puede entrar"

Un empleado invitado necesita tener cuenta (para asignarle sucursales y horarios) pero no
tiene contraseña todavía. Dos formas de representarlo: dejar la columna nullable, o
rellenarla con un hash random inservible.

Elegí **nullable**, porque el estado queda explícito: mirando la fila se sabe si activó su
cuenta o no. Con un hash falso, esa pregunta —que la pantalla de empleados hace todo el
tiempo— habría que responderla por otro lado.

El detalle que más me gustó: al cambiar el tipo, **TypeScript marcó los dos únicos lugares
del código que tenían que enterarse** (el login y el cambio de contraseña). No los busqué
yo; los encontró el compilador. Eso es lo que se paga cuando se usa `strict`.

Y en el login, un usuario sin contraseña se rechaza con **el mismo mensaje y el mismo
tiempo** que un email desconocido. Decir "esa cuenta existe pero está pendiente" sería
contarle a cualquiera quién trabaja en el negocio.

### 8. Un token opaco, tres usos

La invitación usa el mismo esquema que el refresh token de la Fase 1: `<id>.<secret>`,
donde en la base queda solo el hash argon2 del secreto. El `<id>` viaja al lado porque un
hash con salt **no se puede buscar por igualdad**: sin él habría que traer todas las filas
y verificarlas de a una.

Como ya iba por el segundo uso (y el reset de contraseña va a ser el tercero), saqué la
lógica a `opaque-token.util.ts`. La regla que sigo: **a la segunda vez se extrae, no a la
primera** — antes de eso todavía no se sabe cuál es la parte que de verdad se repite.

Consecuencia práctica: el link se muestra **una sola vez**. No es un descuido, es la
definición de guardar solo el hash. Si se pierde, se reenvía (y eso revoca el anterior).

### 9. Todos los rechazos de la activación dicen lo mismo

Token mal formado, inexistente, vencido, ya usado, empleado dado de baja: **un solo
mensaje para todos**. Si los distinguiera, cualquiera con un link viejo podría averiguar
si esa cuenta existe y en qué estado está.

Hay un test que junta los mensajes de varios fracasos distintos y verifica que sean todos
iguales. Es la clase de detalle que se pierde en la primera refactorización si nadie lo
fija.

### 10. La extension inyecta el `tenantId`, pero TypeScript no lo sabe

Primer roce real del patrón de tenant-scoping. Los tipos que genera Prisma exigen
`tenantId` en cada `create`, pero pasarlo a mano sería un error: la extension hace
`{ tenantId, ...data }`, así que **el explícito le gana al del contexto**.

La salida fácil era `as any`, que apaga el chequeo de todas las propiedades del objeto.
En su lugar escribí `scopedCreate<T>()`, que apaga el de **una sola**:

```ts
data: scopedCreate<Prisma.BranchUncheckedCreateInput>({ name: dto.name });
```

Sigue habiendo un cast, pero acotado y con un nombre que explica por qué existe.

### 11. Los límites del plan y una carrera que decidí no correr

Antes de crear una sucursal o invitar a alguien, se cuenta lo que hay y se compara con el
plan. Entre el `count` y el `INSERT` queda una ventana en la que dos requests simultáneos
podrían pasar los dos.

Decidí **no cerrarla**, y dejarlo escrito en el código. Cerrarla pide un advisory lock o un
contador con constraint; el costo no se justifica para algo que un negocio hace tres veces
por año. Lo que sí me importa es que sea una decisión anotada y no un descuido: la
diferencia entre las dos cosas es solo el comentario.

### 12. Proteger al dueño y a uno mismo

Dos reglas que no estaban en el roadmap y agregué igual:

- **Al dueño no se lo puede desactivar, borrar ni cambiar de rol.** La base ya garantiza un
  solo owner activo por negocio; esto evita llegar a cero.
- **Nadie puede desactivarse ni darse de baja a sí mismo.** Es la típica que termina en un
  pedido de soporte: un administrador se saca los permisos y ya no puede devolvérselos.

Ninguna de las dos es difícil. Las dos son la diferencia entre una API correcta y una que
además cuida al que la usa.

### 13. `isActive` y `deletedAt` no son lo mismo

Aparece en las dos entidades de esta fase y vale para todas las que vienen:

- **desactivada**: sigue existiendo, no aparece en la agenda, conserva su historial y
  **sigue ocupando lugar del plan**. Es reversible: una sucursal cerrada por refacción, un
  empleado con licencia.
- **borrada**: baja lógica, desaparece de las listas y libera el lugar del plan.

Que una sucursal desactivada siga contando para el límite no es un detalle técnico: es una
decisión de producto, y está probada.

---

## 🔗 Cómo se conecta con lo anterior

| De la Fase 0/1 | Cómo se usa acá |
|---|---|
| `prisma.scoped` + extension de tenant | Todos los services de la fase. Ninguna query filtra por `tenantId` a mano. |
| Guard global + `@Roles()` | Leer alcanza con estar autenticado; administrar es `OWNER` + `ADMINISTRATIVE`. |
| `@Public()` | La activación de un empleado: la abre el token de la invitación, no el JWT. |
| Token opaco del refresh | La invitación copia el esquema; los helpers ahora son compartidos. |
| Soft delete | Sucursales, empleados y ausencias. Los horarios y las tablas de unión están exentos: se borran de verdad. |
| Infra de e2e | Se reusó tal cual; solo hizo falta un helper para cambiar de plan. |

---

## 📝 Autoevaluación

Preguntas para responder en voz alta:

1. ¿Por qué el horario de una sucursal es `TIME` y una ausencia es `TIMESTAMPTZ`?
2. ¿Por qué el horario del empleado tiene una fila por tramo y el de la sucursal una por día?
3. ¿Por qué dos tramos del mismo empleado no se pueden pisar aunque sean de sucursales distintas?
4. ¿Por qué `password_hash` es nullable y qué pasa si alguien intenta loguearse con esa cuenta?
5. ¿Por qué el link de invitación se puede ver una sola vez?
6. ¿Por qué todos los errores de la activación dicen lo mismo?
7. ¿Por qué existe `scopedCreate` en vez de un `as any`?
8. ¿Qué diferencia hay entre desactivar y borrar, y cuál libera lugar del plan?
9. ¿Por qué las reglas de horario están escritas dos veces?
10. ¿Qué carrera quedó abierta en los límites del plan y por qué no la cerré?

---

## ✅ Fase cerrada

Con sucursales y empleados, el negocio ya tiene **dónde** y **quién**. Lo que sigue es el
**qué** (Fase 3: catálogo de servicios) y recién después, con las tres cosas firmes,
los turnos — que es donde todo esto se junta.
