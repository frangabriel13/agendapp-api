# 📊 Modelo de Datos — AgendApp

> **Documento de referencia.** No es el `schema.prisma` final.
> Usalo como guía para ir construyendo el schema real de a poco.

---

## 🧭 Decisiones generales del modelo

- **Multi-tenancy:** una cuenta = un negocio. Todas las tablas de negocio llevan: `tenant_id`.
- **Soft delete:** todas las tablas relevantes tienen `deleted_at` en lugar de borrar registros.
- **Auditoría:** tabla `audit_logs` desde el día 1.
- **Owner:** siempre es un `Employee` más, con flag `is_owner`. Cuenta dentro del límite del plan.
- **Slugs:** únicos. Si se cambia, el link viejo deja de funcionar.
- **Identificadores:** UUID v4 en todas las tablas (no autoincrementales).
- **Money:** todos los montos en `cents` (INT) para evitar problemas de decimales.
- **Fechas:** todas en UTC en la base. Conversión a zona del tenant en la app.
- **Idioma/Moneda/TZ:** soporte futuro multi-país, hoy default Argentina.

---

## 🗂️ Índice de dominios

1. [Cuentas y Autenticación](#-1-cuentas-y-autenticación)
2. [Negocio (Tenant)](#-2-negocio-tenant)
3. [Suscripciones y Planes](#-3-suscripciones-y-planes)
4. [Sucursales](#-4-sucursales)
5. [Empleados](#-5-empleados)
6. [Servicios y Recursos](#-6-servicios-y-recursos)
7. [Clientes Finales](#-7-clientes-finales)
8. [Turnos (corazón del sistema)](#-8-turnos)
9. [Pagos de Turnos](#-9-pagos-de-turnos)
10. [Notas Internas](#-10-notas-internas)
11. [Auditoría](#-11-auditoría)

---

## 🔐 1. Cuentas y Autenticación

### `users`
Usuarios que se logean al sistema (owner + empleados).

| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | PK |
| `email` | VARCHAR | UNIQUE |
| `password_hash` | VARCHAR | argon2 |
| `first_name` | VARCHAR | |
| `last_name` | VARCHAR | |
| `phone` | VARCHAR | nullable |
| `email_verified_at` | TIMESTAMP | nullable |
| `last_login_at` | TIMESTAMP | nullable |
| `created_at` | TIMESTAMP | |
| `updated_at` | TIMESTAMP | |
| `deleted_at` | TIMESTAMP | nullable (soft delete) |

### `refresh_tokens`
Tokens de refresh para JWT, con rotación y detección de reuso.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | PK — viaja dentro del token para poder ubicar la fila |
| `user_id` | UUID | FK → users |
| `family_id` | UUID | agrupa la cadena de rotaciones de un mismo login |
| `token_hash` | VARCHAR | argon2 |
| `expires_at` | TIMESTAMP | |
| `revoked_at` | TIMESTAMP | nullable |
| `created_at` | TIMESTAMP | |

**Notas:**
- El token que recibe el cliente es `<id>.<secret>`: el `id` ubica la fila y el `secret` se verifica con argon2 contra `token_hash` (un hash con salt no se puede buscar por igualdad).
- En cada refresh se revoca el token viejo y se emite uno nuevo con el mismo `family_id`. Si llega un token ya revocado, se revoca **toda la familia** (señal de robo de token).

---

## 🏢 2. Negocio (Tenant)

### `tenants`
Cada negocio suscripto a la plataforma.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | PK |
| `owner_user_id` | UUID | FK → users, UNIQUE |
| `business_name` | VARCHAR | |
| `slug` | VARCHAR | UNIQUE (para subdominio) |
| `plan_id` | UUID | FK → plans |
| `subscription_status` | ENUM | trial, active, past_due, canceled |
| `trial_ends_at` | TIMESTAMP | nullable |
| `timezone` | VARCHAR | default 'America/Argentina/Buenos_Aires' |
| `currency` | VARCHAR | default 'ARS' |
| `language` | VARCHAR | default 'es' |
| `created_at` | TIMESTAMP | |
| `updated_at` | TIMESTAMP | |
| `deleted_at` | TIMESTAMP | nullable |

**Notas:**
- `tenants` NO lleva `tenant_id` (él ES el tenant): está en `TENANT_EXEMPT_MODELS` y los services lo filtran por `id`.
- El `slug` se genera del `business_name` al registrarse (con sufijo numérico si choca) y **hoy no se puede editar por la API**: es la URL pública del portal (Fase 7) y cambiarlo rompe los links ya compartidos.

### `tenant_branding`
Personalización visual del portal público.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | PK |
| `tenant_id` | UUID | FK → tenants, UNIQUE |
| `logo_url` | VARCHAR | nullable |
| `primary_color` | VARCHAR | nullable (hex) |
| `display_name` | VARCHAR | nombre comercial mostrado |
| `description` | TEXT | nullable |
| `created_at` | TIMESTAMP | |
| `updated_at` | TIMESTAMP | |

### `tenant_settings`
Configuraciones generales del negocio.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | PK |
| `tenant_id` | UUID | FK → tenants, UNIQUE |
| `cancellation_policy_hours` | INT | hs antes para cancelar |
| `cancellation_refund_type` | ENUM | full, partial, credit, none |
| `cancellation_refund_percentage` | INT | nullable (si partial) |
| `require_deposit_for_booking` | BOOLEAN | |
| `default_buffer_minutes` | INT | default 0 |
| `created_at` | TIMESTAMP | |
| `updated_at` | TIMESTAMP | |

**Notas:**
- `tenant_branding` y `tenant_settings` se crean en la misma transacción que el tenant (`POST /auth/register`), así que ningún negocio existe sin ellas. La API expone `GET/PATCH /tenants/me/branding` y `/settings`; no hay alta ni baja.
- Los CHECK de coherencia de la política de cancelación ya están en la base (ver "Constraints críticos", punto 7) y el service repite la validación para devolver un 400 legible en vez de un 500 de Postgres.

---

## 💳 3. Suscripciones y Planes

### `plans`
Catálogo global de planes (Básico, Pro, Avanzado, Business).

| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | PK |
| `name` | VARCHAR | |
| `slug` | VARCHAR | UNIQUE |
| `price_monthly_cents` | INT | nullable (`null` = a medida, plan Empresa) |
| `price_yearly_cents` | INT | nullable |
| `max_employees` | INT | nullable (`null` = sin límite). **Incluye al owner** |
| `max_branches` | INT | nullable (`null` = sin límite) |
| `includes_clinic_records` | BOOLEAN | ficha clínica digital |
| `includes_resources` | BOOLEAN | control de equipos/inventario (Fase 3) |
| `support_level` | ENUM | standard, priority |
| `is_active` | BOOLEAN | |
| `display_order` | INT | |
| `created_at` | TIMESTAMP | |
| `updated_at` | TIMESTAMP | |

**Planes vigentes** (precios finales en ARS, con IVA incluido; el anual equivale a 11 meses):

| slug | name | mensual | anual | max_employees | max_branches | ficha clínica | equipos | soporte |
|---|---|---|---|---|---|---|---|---|
| `basico` | Básico | $25.000 | $275.000 | 1 | 1 | ✅ | ❌ | standard |
| `pro` | Pro | $45.000 | $495.000 | 4 | 1 | ✅ | ✅ | priority |
| `avanzado` | Avanzado | $80.000 | $880.000 | 7 | 2 | ✅ | ✅ | priority |
| `empresa` | Empresa | a medida | a medida | `null` | `null` | ✅ | ✅ | priority |

### `subscriptions`
Historial de suscripciones del tenant. **Es la fuente de verdad del estado**;
`tenants.subscription_status` y `tenants.trial_ends_at` son copias
desnormalizadas para lecturas rápidas y hay que actualizarlas en la misma
transacción que cambia la suscripción.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | PK |
| `tenant_id` | UUID | FK → tenants |
| `plan_id` | UUID | FK → plans |
| `status` | ENUM | trial, active, past_due, canceled, paused |
| `mp_subscription_id` | VARCHAR | nullable (Mercado Pago) |
| `current_period_start` | TIMESTAMP | |
| `current_period_end` | TIMESTAMP | |
| `canceled_at` | TIMESTAMP | nullable |
| `created_at` | TIMESTAMP | |
| `updated_at` | TIMESTAMP | |

### `subscription_payments`
Cobros realizados de la suscripción.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | PK |
| `subscription_id` | UUID | FK → subscriptions |
| `tenant_id` | UUID | FK → tenants |
| `amount_cents` | INT | |
| `status` | ENUM | pending, succeeded, failed, refunded |
| `mp_payment_id` | VARCHAR | nullable |
| `paid_at` | TIMESTAMP | nullable |
| `failure_reason` | TEXT | nullable |
| `created_at` | TIMESTAMP | |

---

## 🏬 4. Sucursales

### `branches`
Sucursales físicas del negocio. El alta valida `plan.max_branches`.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | PK |
| `tenant_id` | UUID | FK → tenants |
| `name` | VARCHAR(120) | único por tenant entre las no borradas |
| `address` | VARCHAR | nullable |
| `phone` | VARCHAR | nullable |
| `is_active` | BOOLEAN | desactivada ≠ borrada: sigue ocupando lugar del plan |
| `created_at` | TIMESTAMP | |
| `updated_at` | TIMESTAMP | |
| `deleted_at` | TIMESTAMP | nullable |

### `branch_business_hours`
Horario de atención por día de la semana. Siempre 7 filas por sucursal.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | PK |
| `tenant_id` | UUID | FK → tenants |
| `branch_id` | UUID | FK → branches |
| `day_of_week` | SMALLINT | 0=domingo, 6=sábado |
| `opens_at` | TIME | nullable (null si el día está cerrado) |
| `closes_at` | TIME | nullable (null si el día está cerrado) |
| `is_closed` | BOOLEAN | si el día está cerrado |
| `created_at` | TIMESTAMP | |
| `updated_at` | TIMESTAMP | |

**Constraints:** `UNIQUE(branch_id, day_of_week)`, `CHECK (day_of_week BETWEEN 0 AND 6)` y el CHECK de horario: o cerrado y sin horas, o abierto con las dos y `closes_at > opens_at`.

### `branch_special_days`
Feriados, vacaciones, días especiales por sucursal. Pisan al horario semanal.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | PK |
| `tenant_id` | UUID | FK → tenants |
| `branch_id` | UUID | FK → branches |
| `date` | DATE | |
| `is_closed` | BOOLEAN | default `true` (el caso común es el feriado) |
| `opens_at` | TIME | nullable |
| `closes_at` | TIME | nullable |
| `description` | VARCHAR | nullable |
| `created_at` | TIMESTAMP | |
| `updated_at` | TIMESTAMP | |

**Constraints:** `UNIQUE(branch_id, date)` y el mismo CHECK de horario que `branch_business_hours`.

**Estado de implementación:** las tres tablas existen desde la Fase 2.1 (migración `20260812112622_branches`), con tres decisiones que se apartan del modelo conceptual de arriba:

1. **`tenant_id` también en las tablas hijas**, aunque se llegue a ellas por `branch_id`. Es la convención de todas las tablas de negocio: sin esa columna la extension de tenant-scope no las puede filtrar (habría que exceptuarlas) y la RLS de la Fase 8 tampoco tendría por dónde agarrarlas.
2. **`opens_at` / `closes_at` nullables en `branch_business_hours`**, para que un día cerrado no tenga que inventar horas. El CHECK obliga a que sea todo o nada, así que no puede quedar un día "abierto" sin horario.
3. **`branches` tiene un índice único parcial** `(tenant_id, lower(name)) WHERE deleted_at IS NULL`: dos sucursales con el mismo nombre no se distinguen al agendar. Es parcial para que dar de baja una libere el nombre, y sobre `lower(name)` para que "Centro" y "centro" cuenten como el mismo.

Los `TIME` viajan por la API como `"HH:MM"` y las fechas como `"YYYY-MM-DD"`: Prisma los devuelve como `Date` (ancladas al 1970-01-01 y a medianoche UTC respectivamente) y la conversión vive en `src/common/utils/`. **Limitación conocida:** `closes_at > opens_at` no admite horarios que crucen la medianoche.

---

## 👥 5. Empleados

### `employees`
Profesionales y administrativos del negocio.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | PK |
| `tenant_id` | UUID | FK → tenants |
| `user_id` | UUID | FK → users (cuenta de login) |
| `role` | ENUM | owner, professional, administrative |
| `is_owner` | BOOLEAN | redundante pero útil |
| `is_active` | BOOLEAN | |
| `hired_at` | DATE | nullable |
| `bio` | TEXT | nullable |
| `avatar_url` | VARCHAR | nullable |
| `created_at` | TIMESTAMP | |
| `updated_at` | TIMESTAMP | |
| `deleted_at` | TIMESTAMP | nullable |

**Constraints:**
- `UNIQUE(user_id)` — hoy un usuario pertenece a **un solo negocio**, así que el unique es sobre `user_id` solo (subsume al `UNIQUE(tenant_id, user_id)` original). Si algún día soportamos usuarios multi-negocio, se reemplaza por el compuesto.
- `UNIQUE(tenant_id) WHERE is_owner AND deleted_at IS NULL` — índice parcial: un solo owner activo por negocio.

**Estado de implementación:** la Fase 1 creó la versión mínima (`tenant_id`, `user_id`, `role`, `is_owner`, `is_active` + timestamps), porque `/auth/register` necesita crear al owner. `hired_at`, `bio` y `avatar_url` se agregan en la Fase 2.

### `employee_branches`
Sucursales donde trabaja cada empleado.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | PK |
| `employee_id` | UUID | FK → employees |
| `branch_id` | UUID | FK → branches |
| `created_at` | TIMESTAMP | |

**Constraints:** `UNIQUE(employee_id, branch_id)`

### `employee_schedules`
Horario semanal por empleado y sucursal (puede ser distinto en cada sucursal).

| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | PK |
| `employee_id` | UUID | FK → employees |
| `branch_id` | UUID | FK → branches |
| `day_of_week` | INT | |
| `starts_at` | TIME | |
| `ends_at` | TIME | |

### `employee_time_off`
Vacaciones, ausencias, bloqueos personales.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | PK |
| `employee_id` | UUID | FK → employees |
| `branch_id` | UUID | FK → branches, nullable (null = todas) |
| `starts_at` | TIMESTAMP | |
| `ends_at` | TIMESTAMP | |
| `reason` | VARCHAR | nullable |
| `created_at` | TIMESTAMP | |

---

## ✂️ 6. Servicios y Recursos

### `service_categories`
Categorías de servicios (las crea el owner).

| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | PK |
| `tenant_id` | UUID | FK → tenants |
| `name` | VARCHAR | |
| `display_order` | INT | |
| `created_at` | TIMESTAMP | |
| `deleted_at` | TIMESTAMP | nullable |

### `services`
Servicios que ofrece el negocio.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | PK |
| `tenant_id` | UUID | FK → tenants |
| `category_id` | UUID | FK → service_categories, nullable |
| `name` | VARCHAR | |
| `description` | TEXT | nullable |
| `duration_minutes` | INT | |
| `price_cents` | INT | |
| `deposit_amount_cents` | INT | nullable (null = sin seña) |
| `buffer_after_minutes` | INT | default 0 |
| `color` | VARCHAR | nullable (para agenda) |
| `is_active` | BOOLEAN | |
| `created_at` | TIMESTAMP | |
| `updated_at` | TIMESTAMP | |
| `deleted_at` | TIMESTAMP | nullable |

### `employee_services`
Qué servicios presta cada empleado en cada sucursal.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | PK |
| `employee_id` | UUID | FK → employees |
| `service_id` | UUID | FK → services |
| `branch_id` | UUID | FK → branches |

**Constraints:** `UNIQUE(employee_id, service_id, branch_id)`

### `resources`
Camillas, sillones, salas — pertenecen a una sucursal.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | PK |
| `tenant_id` | UUID | FK → tenants |
| `branch_id` | UUID | FK → branches |
| `name` | VARCHAR | |
| `description` | TEXT | nullable |
| `is_active` | BOOLEAN | |
| `created_at` | TIMESTAMP | |
| `updated_at` | TIMESTAMP | |
| `deleted_at` | TIMESTAMP | nullable |

### `service_resources`
Recursos que requiere un servicio (un servicio puede requerir varios).

| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | PK |
| `service_id` | UUID | FK → services |
| `resource_id` | UUID | FK → resources |

**Constraints:** `UNIQUE(service_id, resource_id)`

---

## 👤 7. Clientes Finales

### `customers`
Clientes del negocio. No se logean, los crea el negocio o se autogeneran al reservar online.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | PK |
| `tenant_id` | UUID | FK → tenants |
| `first_name` | VARCHAR | |
| `last_name` | VARCHAR | nullable |
| `phone` | VARCHAR | |
| `email` | VARCHAR | nullable |
| `date_of_birth` | DATE | nullable |
| `notes` | TEXT | nullable |
| `created_at` | TIMESTAMP | |
| `updated_at` | TIMESTAMP | |
| `deleted_at` | TIMESTAMP | nullable |

**Índices:**
- `INDEX(tenant_id, phone)` — para detección de duplicados
- `INDEX(tenant_id, email)`

### `customer_tags`
Etiquetas para segmentar clientes.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | PK |
| `tenant_id` | UUID | FK → tenants |
| `name` | VARCHAR | |
| `color` | VARCHAR | nullable |

### `customer_tag_assignments`

| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | PK |
| `customer_id` | UUID | FK → customers |
| `tag_id` | UUID | FK → customer_tags |

**Constraints:** `UNIQUE(customer_id, tag_id)`

---

## 📅 8. Turnos

### `appointments`
Turnos (corazón del sistema).

| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | PK |
| `tenant_id` | UUID | FK → tenants |
| `branch_id` | UUID | FK → branches |
| `employee_id` | UUID | FK → employees |
| `customer_id` | UUID | FK → customers |
| `starts_at` | TIMESTAMP | UTC |
| `ends_at` | TIMESTAMP | UTC |
| `status` | ENUM | ver lista abajo |
| `total_price_cents` | INT | |
| `deposit_amount_cents` | INT | nullable |
| `deposit_paid` | BOOLEAN | default false |
| `notes` | TEXT | nullable |
| `created_by_user_id` | UUID | FK → users, nullable |
| `created_via` | ENUM | admin, public_booking, recurring |
| `recurrence_group_id` | UUID | nullable, FK → recurrence_groups |
| `rescheduled_from_id` | UUID | FK → appointments, nullable |
| `rescheduled_to_id` | UUID | FK → appointments, nullable |
| `canceled_at` | TIMESTAMP | nullable |
| `cancellation_reason` | TEXT | nullable |
| `created_at` | TIMESTAMP | |
| `updated_at` | TIMESTAMP | |
| `deleted_at` | TIMESTAMP | nullable |

**Estados posibles:**
- `pending_payment` — esperando pago de seña
- `confirmed` — pago confirmado, turno agendado
- `attended` — el cliente se presentó y se atendió
- `no_show` — el cliente no se presentó
- `canceled_by_customer`
- `canceled_by_business`
- `rescheduled` — reprogramado (con referencia al nuevo turno)

**Índices:**
- `INDEX(tenant_id, starts_at)`
- `INDEX(employee_id, starts_at)`
- `INDEX(branch_id, starts_at)`
- `INDEX(customer_id)`

**Constraints críticos:**
- `CHECK(ends_at > starts_at)`
- `EXCLUSION CONSTRAINT` sobre `(employee_id, tstzrange(starts_at, ends_at))` para prevenir doble-booking del empleado.

### `appointment_services`
Servicios incluidos en un turno (puede ser más de uno con el mismo profesional).

| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | PK |
| `appointment_id` | UUID | FK → appointments |
| `service_id` | UUID | FK → services |
| `duration_minutes` | INT | snapshot al momento del turno |
| `price_cents` | INT | snapshot al momento del turno |

> **Importante:** `duration_minutes` y `price_cents` se guardan como **snapshot** del valor del servicio al momento de la reserva. Esto evita que si el dueño cambia el precio mañana, los turnos viejos se vean alterados.

### `appointment_resources`
Recursos reservados para el turno.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | PK |
| `appointment_id` | UUID | FK → appointments |
| `resource_id` | UUID | FK → resources |

**Constraints:**
- `UNIQUE(appointment_id, resource_id)`
- `EXCLUSION CONSTRAINT` para prevenir que un mismo recurso esté en dos turnos solapados.

### `recurrence_groups`
Define una regla de recurrencia (los turnos se generan individualmente).

| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | PK |
| `tenant_id` | UUID | FK → tenants |
| `frequency` | ENUM | weekly, biweekly, monthly |
| `day_of_week` | INT | nullable |
| `occurrences` | INT | total de turnos generados |
| `created_at` | TIMESTAMP | |

---

## 💰 9. Pagos de Turnos

### `appointment_payments`
Pagos asociados a turnos (seña, total, restante, reembolso).

| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | PK |
| `appointment_id` | UUID | FK → appointments |
| `tenant_id` | UUID | FK → tenants |
| `amount_cents` | INT | |
| `payment_type` | ENUM | deposit, full, remainder, refund |
| `payment_method` | ENUM | mercadopago, cash, transfer, other |
| `status` | ENUM | pending, succeeded, failed, refunded |
| `mp_payment_id` | VARCHAR | nullable |
| `recorded_by_user_id` | UUID | FK → users, nullable |
| `notes` | TEXT | nullable |
| `paid_at` | TIMESTAMP | nullable |
| `created_at` | TIMESTAMP | |

> `recorded_by_user_id` es null cuando el pago fue online del cliente (autoservicio).

---

## 📝 10. Notas Internas

### `notes`
Notas polimórficas: pueden ser sobre customer, appointment, employee, branch o generales.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | PK |
| `tenant_id` | UUID | FK → tenants |
| `author_user_id` | UUID | FK → users |
| `content` | TEXT | |
| `is_private` | BOOLEAN | default false (el owner siempre la ve igual) |
| `entity_type` | ENUM | customer, appointment, employee, branch, general |
| `entity_id` | UUID | nullable (null si es general) |
| `created_at` | TIMESTAMP | |
| `updated_at` | TIMESTAMP | |
| `deleted_at` | TIMESTAMP | nullable |

**Índices:**
- `INDEX(tenant_id, entity_type, entity_id)`

---

## 📊 11. Auditoría

### `audit_logs`
Log básico desde el día 1.

| Campo | Tipo | Notas |
|---|---|---|
| `id` | UUID | PK |
| `tenant_id` | UUID | FK → tenants, nullable |
| `user_id` | UUID | FK → users, nullable |
| `action` | VARCHAR | created, updated, deleted, login, etc. |
| `entity_type` | VARCHAR | appointment, customer, etc. |
| `entity_id` | UUID | nullable |
| `changes` | JSONB | nullable (diff de cambios) |
| `ip_address` | VARCHAR | nullable |
| `user_agent` | VARCHAR | nullable |
| `created_at` | TIMESTAMP | |

**Índices:**
- `INDEX(tenant_id, created_at)`
- `INDEX(entity_type, entity_id)`

---

## 🗺️ Mapa de relaciones

```
users ──< employees >── tenants ──< tenant_branding
                          │       └─< tenant_settings
                          │
                          ├──< branches ──< branch_business_hours
                          │       ├──< branch_special_days
                          │       └──< resources
                          │
                          ├──< employee_branches >── branches
                          ├──< employee_schedules
                          ├──< employee_time_off
                          │
                          ├──< services ──< service_resources >── resources
                          │       └──< employee_services
                          ├──< service_categories
                          │
                          ├──< customers ──< customer_tag_assignments
                          │       └── customer_tags
                          │
                          ├──< appointments ──< appointment_services
                          │         ├──< appointment_resources
                          │         └──< appointment_payments
                          ├──< recurrence_groups
                          │
                          ├──< notes
                          ├──< audit_logs
                          └──< subscriptions ──< subscription_payments
                                   └── plans
```

---

## 🛡️ Constraints críticos a no olvidar al implementar

1. **EXCLUSION CONSTRAINT en `appointments`** — un mismo `employee_id` no puede tener dos turnos solapados.
   ```sql
   EXCLUDE USING gist (
     employee_id WITH =,
     tstzrange(starts_at, ends_at) WITH &&
   ) WHERE (status NOT IN ('canceled_by_customer', 'canceled_by_business', 'rescheduled'))
   ```

2. **EXCLUSION CONSTRAINT en `appointment_resources`** — un recurso no puede estar en dos turnos solapados.

3. **Row-Level Security (RLS)** en todas las tablas con `tenant_id` para aislamiento garantizado a nivel de Postgres.

4. **CHECK constraint** `ends_at > starts_at` en `appointments`, `employee_time_off`, `branch_special_days`.

5. **Soft delete bien aplicado** — los queries deben filtrar `deleted_at IS NULL` por default (Prisma tiene middleware para esto).

6. **Índice parcial de owner único** en `employees` — ya implementado en la migración `auth_and_tenant_base`:
   ```sql
   CREATE UNIQUE INDEX ON employees (tenant_id) WHERE is_owner AND deleted_at IS NULL;
   ```

7. **CHECK constraints de la Fase 1** — ya implementados en la migración `auth_and_tenant_base`: `subscriptions.current_period_end > current_period_start`; en `tenant_settings`, el porcentaje de reembolso entre 0 y 100, obligatorio cuando `cancellation_refund_type = 'partial'`, y ventanas (`cancellation_policy_hours`, `default_buffer_minutes`) no negativas.

---

## 📦 Orden recomendado para implementar el schema

Vas a ir creando las tablas de a poco. Este es el orden lógico para que no te trabes con foreign keys faltantes:

1. **Base de auth y tenant** — `users`, `tenants`, `plans`, `subscriptions`
2. **Estructura del negocio** — `branches`, `tenant_branding`, `tenant_settings`
3. **Empleados** — `employees`, `employee_branches`, `employee_schedules`
4. **Servicios** — `service_categories`, `services`, `employee_services`
5. **Recursos** — `resources`, `service_resources`
6. **Clientes** — `customers`, `customer_tags`, `customer_tag_assignments`
7. **Turnos** — `appointments`, `appointment_services`, `appointment_resources`, `recurrence_groups`
8. **Pagos** — `appointment_payments`, `subscription_payments`
9. **Notas y auditoría** — `notes`, `audit_logs`
10. **Refresh tokens** — `refresh_tokens` (cuando hagas auth)
11. **Time off** — `employee_time_off`, `branch_special_days`

---

## 📌 Notas finales

- Este documento es la **referencia conceptual**, no el `schema.prisma` final.
- Cuando implementes una tabla, traducila a sintaxis Prisma siguiendo las convenciones:
  - Modelos en **PascalCase singular** (`User`, `Tenant`, `Appointment`)
  - Campos en **camelCase** (`firstName`, `tenantId`)
  - Usar `@map("snake_case")` para mapear a nombres de columna SQL en snake_case
  - Usar `@@map("snake_case")` para mapear el nombre de la tabla
- Cuando agregues una tabla nueva, actualizá este documento también.
