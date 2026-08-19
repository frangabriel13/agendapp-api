-- CreateEnum
CREATE TYPE "appointment_status" AS ENUM ('pending_payment', 'confirmed', 'attended', 'no_show', 'canceled_by_customer', 'canceled_by_business', 'rescheduled');

-- CreateEnum
CREATE TYPE "appointment_source" AS ENUM ('admin', 'public_booking', 'recurring');

-- CreateEnum
CREATE TYPE "recurrence_frequency" AS ENUM ('weekly', 'biweekly', 'monthly');

-- CreateTable
CREATE TABLE "appointments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ NOT NULL,
    "ends_at" TIMESTAMPTZ NOT NULL,
    "status" "appointment_status" NOT NULL DEFAULT 'confirmed',
    "total_price_cents" INTEGER NOT NULL,
    "deposit_amount_cents" INTEGER,
    "deposit_paid" BOOLEAN NOT NULL DEFAULT false,
    "notes" TEXT,
    "created_by_user_id" UUID,
    "created_via" "appointment_source" NOT NULL DEFAULT 'admin',
    "recurrence_group_id" UUID,
    "canceled_at" TIMESTAMPTZ,
    "cancellation_reason" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,
    "rescheduled_from_id" UUID,

    CONSTRAINT "appointments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_services" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointment_services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "appointment_resources" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "resource_id" UUID NOT NULL,
    "starts_at" TIMESTAMPTZ NOT NULL,
    "ends_at" TIMESTAMPTZ NOT NULL,
    "blocks_slot" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointment_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurrence_groups" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "frequency" "recurrence_frequency" NOT NULL,
    "day_of_week" SMALLINT,
    "occurrences" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recurrence_groups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "appointments_rescheduled_from_id_key" ON "appointments"("rescheduled_from_id");

-- CreateIndex
CREATE INDEX "appointments_tenant_id_starts_at_idx" ON "appointments"("tenant_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointments_employee_id_starts_at_idx" ON "appointments"("employee_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointments_branch_id_starts_at_idx" ON "appointments"("branch_id", "starts_at");

-- CreateIndex
CREATE INDEX "appointments_customer_id_idx" ON "appointments"("customer_id");

-- CreateIndex
CREATE INDEX "appointments_recurrence_group_id_idx" ON "appointments"("recurrence_group_id");

-- CreateIndex
CREATE INDEX "appointment_services_tenant_id_idx" ON "appointment_services"("tenant_id");

-- CreateIndex
CREATE INDEX "appointment_services_service_id_idx" ON "appointment_services"("service_id");

-- CreateIndex
CREATE UNIQUE INDEX "appointment_services_appointment_id_service_id_key" ON "appointment_services"("appointment_id", "service_id");

-- CreateIndex
CREATE INDEX "appointment_resources_tenant_id_idx" ON "appointment_resources"("tenant_id");

-- CreateIndex
CREATE INDEX "appointment_resources_resource_id_starts_at_idx" ON "appointment_resources"("resource_id", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "appointment_resources_appointment_id_resource_id_key" ON "appointment_resources"("appointment_id", "resource_id");

-- CreateIndex
CREATE INDEX "recurrence_groups_tenant_id_idx" ON "recurrence_groups"("tenant_id");

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_recurrence_group_id_fkey" FOREIGN KEY ("recurrence_group_id") REFERENCES "recurrence_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_rescheduled_from_id_fkey" FOREIGN KEY ("rescheduled_from_id") REFERENCES "appointments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_services" ADD CONSTRAINT "appointment_services_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_services" ADD CONSTRAINT "appointment_services_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_services" ADD CONSTRAINT "appointment_services_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_resources" ADD CONSTRAINT "appointment_resources_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_resources" ADD CONSTRAINT "appointment_resources_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_resources" ADD CONSTRAINT "appointment_resources_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "resources"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurrence_groups" ADD CONSTRAINT "recurrence_groups_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- SQL escrito a mano (Prisma no lo genera desde el schema).
-- Si tocás estas tablas, revisá también esta parte.
-- ============================================================================

-- `btree_gist` ya viene de la migración 20260515120000_enable_extensions: hace
-- falta para combinar en un mismo índice GiST una igualdad (`employee_id`) con
-- un solapamiento de rangos.

ALTER TABLE "appointments"
    ADD CONSTRAINT "appointments_ends_after_starts_check"
    CHECK ("ends_at" > "starts_at");

ALTER TABLE "appointments"
    ADD CONSTRAINT "appointments_total_price_check"
    CHECK ("total_price_cents" >= 0);

ALTER TABLE "appointments"
    ADD CONSTRAINT "appointments_deposit_check"
    CHECK ("deposit_amount_cents" IS NULL
        OR ("deposit_amount_cents" >= 0
            AND "deposit_amount_cents" <= "total_price_cents"));

-- Un turno cancelado tiene fecha de cancelación, y uno vivo no. Sin esto queda
-- la duda de si un `canceled_at` viejo significa algo.
ALTER TABLE "appointments"
    ADD CONSTRAINT "appointments_canceled_at_check"
    CHECK (
        ("status" IN ('canceled_by_customer', 'canceled_by_business')
            AND "canceled_at" IS NOT NULL)
        OR ("status" NOT IN ('canceled_by_customer', 'canceled_by_business')
            AND "canceled_at" IS NULL)
    );

-- ── El corazón de la fase: doble-booking imposible ──────────────────────────
--
-- Esto NO se puede resolver en el código. Dos requests simultáneas al mismo
-- slot pasan las dos la validación de disponibilidad (todavía no hay nada que
-- las moleste) y las dos insertan. La única que puede desempatar es la base.
--
-- El WHERE deja afuera los estados que liberan la agenda. **Tiene que decir lo
-- mismo que `NON_BLOCKING_STATUSES`** en
-- `src/modules/appointments/availability.ts`: si aparece un estado nuevo, van
-- los dos lados o queda un agujero silencioso.
--
-- `ends_at` incluye el buffer del servicio, así que el rango que se compara ya
-- es el tiempo real que el profesional está ocupado.
ALTER TABLE "appointments"
    ADD CONSTRAINT "appointments_no_employee_overlap"
    EXCLUDE USING gist (
        "employee_id" WITH =,
        tstzrange("starts_at", "ends_at") WITH &&
    ) WHERE (
        "status" NOT IN ('canceled_by_customer', 'canceled_by_business', 'rescheduled')
        AND "deleted_at" IS NULL
    );

-- ── Lo mismo para los recursos ──────────────────────────────────────────────
--
-- El roadmap proponía leer `starts_at`/`ends_at` del turno con un subquery
-- adentro del EXCLUDE. **Eso no compila**: Postgres no admite subqueries en la
-- definición de un índice. De las dos salidas posibles (desnormalizar o un
-- trigger) se eligió desnormalizar: la lógica queda en TypeScript, donde se
-- testea, en vez de en un trigger que no se ve desde el código.
--
-- El costo es que `appointment_resources.starts_at/ends_at/blocks_slot` son
-- copia y pueden desincronizarse. Los escribe un solo método
-- (`AppointmentsService.syncResourceMirror`) y hay tests que lo cubren.
ALTER TABLE "appointment_resources"
    ADD CONSTRAINT "appointment_resources_ends_after_starts_check"
    CHECK ("ends_at" > "starts_at");

ALTER TABLE "appointment_resources"
    ADD CONSTRAINT "appointment_resources_no_overlap"
    EXCLUDE USING gist (
        "resource_id" WITH =,
        tstzrange("starts_at", "ends_at") WITH &&
    ) WHERE ("blocks_slot");

-- ── Recurrencia ─────────────────────────────────────────────────────────────

ALTER TABLE "recurrence_groups"
    ADD CONSTRAINT "recurrence_groups_day_of_week_check"
    CHECK ("day_of_week" IS NULL OR "day_of_week" BETWEEN 0 AND 6);

ALTER TABLE "recurrence_groups"
    ADD CONSTRAINT "recurrence_groups_occurrences_check"
    CHECK ("occurrences" > 0 AND "occurrences" <= 52);
