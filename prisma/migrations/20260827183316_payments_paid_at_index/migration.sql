-- El listado de cobros por rango (`GET /payments`) filtra por `paid_at` y no
-- por `created_at`: lo que importa es cuándo entró la plata, no cuándo se creó
-- la fila. El único índice que había sobre el tenant era `(tenant_id,
-- created_at)`, que para ese filtro no sirve.
--
-- **Es parcial a propósito.** Un pago pendiente o fallado tiene `paid_at` en
-- null y no puede caer nunca dentro de un rango, así que indexarlo sería
-- ocupar lugar con filas que la consulta descarta por definición. Postgres usa
-- el índice igual, porque el `WHERE paid_at BETWEEN ...` de la query implica
-- `paid_at IS NOT NULL`.
--
-- Prisma no representa índices parciales, así que este vive solo acá: no está
-- en `schema.prisma` y no se regenera solo. Mismo criterio que los índices
-- únicos parciales de las migraciones anteriores.
CREATE INDEX "appointment_payments_tenant_id_paid_at_idx"
  ON "appointment_payments" ("tenant_id", "paid_at")
  WHERE "paid_at" IS NOT NULL;
