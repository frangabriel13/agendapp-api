-- CreateEnum
CREATE TYPE "payment_status" AS ENUM ('pending', 'succeeded', 'failed', 'refunded');

-- CreateEnum
CREATE TYPE "appointment_payment_type" AS ENUM ('deposit', 'full', 'remainder', 'refund');

-- CreateEnum
CREATE TYPE "payment_method" AS ENUM ('mercadopago', 'cash', 'transfer', 'other');

-- CreateTable
CREATE TABLE "appointment_payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'ARS',
    "payment_type" "appointment_payment_type" NOT NULL,
    "payment_method" "payment_method" NOT NULL,
    "status" "payment_status" NOT NULL DEFAULT 'pending',
    "mp_payment_id" VARCHAR(100),
    "mp_preference_id" VARCHAR(100),
    "checkout_url" TEXT,
    "recorded_by_user_id" UUID,
    "notes" TEXT,
    "failure_reason" TEXT,
    "paid_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "appointment_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_payments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "subscription_id" UUID NOT NULL,
    "amount_cents" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'ARS',
    "status" "payment_status" NOT NULL DEFAULT 'pending',
    "mp_payment_id" VARCHAR(100),
    "period_start" TIMESTAMPTZ NOT NULL,
    "period_end" TIMESTAMPTZ NOT NULL,
    "failure_reason" TEXT,
    "paid_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "subscription_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "appointment_payments_mp_payment_id_key" ON "appointment_payments"("mp_payment_id");

-- CreateIndex
CREATE INDEX "appointment_payments_tenant_id_created_at_idx" ON "appointment_payments"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "appointment_payments_appointment_id_idx" ON "appointment_payments"("appointment_id");

-- CreateIndex
CREATE INDEX "appointment_payments_status_idx" ON "appointment_payments"("status");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_payments_mp_payment_id_key" ON "subscription_payments"("mp_payment_id");

-- CreateIndex
CREATE INDEX "subscription_payments_tenant_id_created_at_idx" ON "subscription_payments"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "subscription_payments_subscription_id_idx" ON "subscription_payments"("subscription_id");

-- CreateIndex
CREATE INDEX "subscription_payments_status_idx" ON "subscription_payments"("status");

-- AddForeignKey
ALTER TABLE "appointment_payments" ADD CONSTRAINT "appointment_payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_payments" ADD CONSTRAINT "appointment_payments_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_payments" ADD CONSTRAINT "appointment_payments_recorded_by_user_id_fkey" FOREIGN KEY ("recorded_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_payments" ADD CONSTRAINT "subscription_payments_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ============================================================================
-- SQL escrito a mano (Prisma no lo genera desde el schema).
-- Si tocás estas tablas, revisá también esta parte.
-- ============================================================================

-- Un movimiento siempre mueve plata. Las devoluciones también se guardan en
-- positivo: el signo lo pone `payment_type = 'refund'`, no el número. Guardar
-- montos negativos haría que cualquier SUM() ingenuo diera un resultado
-- distinto según qué filas agarró.
ALTER TABLE "appointment_payments"
    ADD CONSTRAINT "appointment_payments_amount_check"
    CHECK ("amount_cents" > 0);

-- ISO 4217, en mayúsculas. Sin esto conviven 'ars', 'ARS' y 'Ars' y las
-- comparaciones fallan en silencio.
ALTER TABLE "appointment_payments"
    ADD CONSTRAINT "appointment_payments_currency_check"
    CHECK ("currency" ~ '^[A-Z]{3}$');

-- `paid_at` y `status` no pueden contradecirse: un pago acreditado tiene fecha
-- de acreditación, y uno pendiente o fallido no. `refunded` la conserva, porque
-- efectivamente se cobró antes de devolverse.
ALTER TABLE "appointment_payments"
    ADD CONSTRAINT "appointment_payments_paid_at_check"
    CHECK (
        ("status" IN ('succeeded', 'refunded') AND "paid_at" IS NOT NULL)
        OR ("status" IN ('pending', 'failed') AND "paid_at" IS NULL)
    );

-- Un pago en efectivo con id de Mercado Pago es un bug de quien lo escribió.
ALTER TABLE "appointment_payments"
    ADD CONSTRAINT "appointment_payments_mp_id_method_check"
    CHECK ("mp_payment_id" IS NULL OR "payment_method" = 'mercadopago');

-- Lo mismo para la preferencia de checkout: solo existe si se cobró online.
ALTER TABLE "appointment_payments"
    ADD CONSTRAINT "appointment_payments_mp_preference_method_check"
    CHECK ("mp_preference_id" IS NULL OR "payment_method" = 'mercadopago');

-- ── Suscripciones ───────────────────────────────────────────────────────────

ALTER TABLE "subscription_payments"
    ADD CONSTRAINT "subscription_payments_amount_check"
    CHECK ("amount_cents" > 0);

ALTER TABLE "subscription_payments"
    ADD CONSTRAINT "subscription_payments_currency_check"
    CHECK ("currency" ~ '^[A-Z]{3}$');

ALTER TABLE "subscription_payments"
    ADD CONSTRAINT "subscription_payments_paid_at_check"
    CHECK (
        ("status" IN ('succeeded', 'refunded') AND "paid_at" IS NOT NULL)
        OR ("status" IN ('pending', 'failed') AND "paid_at" IS NULL)
    );

-- Un período de facturación tiene que durar algo.
ALTER TABLE "subscription_payments"
    ADD CONSTRAINT "subscription_payments_period_check"
    CHECK ("period_end" > "period_start");
