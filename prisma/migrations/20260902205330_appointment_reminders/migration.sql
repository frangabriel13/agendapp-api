-- CreateEnum
CREATE TYPE "reminder_kind" AS ENUM ('day_before', 'hours_before');

-- CreateTable
CREATE TABLE "appointment_reminders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "appointment_id" UUID NOT NULL,
    "kind" "reminder_kind" NOT NULL,
    "sent_to" VARCHAR(255),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointment_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "appointment_reminders_tenant_id_created_at_idx" ON "appointment_reminders"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "appointment_reminders_appointment_id_kind_key" ON "appointment_reminders"("appointment_id", "kind");

-- AddForeignKey
ALTER TABLE "appointment_reminders" ADD CONSTRAINT "appointment_reminders_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_reminders" ADD CONSTRAINT "appointment_reminders_appointment_id_fkey" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
