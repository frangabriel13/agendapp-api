-- AlterTable
ALTER TABLE "employees" ADD COLUMN     "avatar_url" VARCHAR(500),
ADD COLUMN     "bio" TEXT,
ADD COLUMN     "hired_at" DATE;

-- AlterTable
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;

-- CreateTable
CREATE TABLE "employee_invitations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "token_hash" VARCHAR(255) NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "accepted_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_branches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_schedules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "day_of_week" SMALLINT NOT NULL,
    "starts_at" TIME(0) NOT NULL,
    "ends_at" TIME(0) NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "employee_schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_time_off" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "branch_id" UUID,
    "starts_at" TIMESTAMPTZ NOT NULL,
    "ends_at" TIMESTAMPTZ NOT NULL,
    "reason" VARCHAR(255),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "employee_time_off_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_invitations_employee_id_idx" ON "employee_invitations"("employee_id");

-- CreateIndex
CREATE INDEX "employee_invitations_tenant_id_idx" ON "employee_invitations"("tenant_id");

-- CreateIndex
CREATE INDEX "employee_invitations_expires_at_idx" ON "employee_invitations"("expires_at");

-- CreateIndex
CREATE INDEX "employee_branches_tenant_id_idx" ON "employee_branches"("tenant_id");

-- CreateIndex
CREATE INDEX "employee_branches_branch_id_idx" ON "employee_branches"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_branches_employee_id_branch_id_key" ON "employee_branches"("employee_id", "branch_id");

-- CreateIndex
CREATE INDEX "employee_schedules_employee_id_branch_id_day_of_week_idx" ON "employee_schedules"("employee_id", "branch_id", "day_of_week");

-- CreateIndex
CREATE INDEX "employee_schedules_tenant_id_idx" ON "employee_schedules"("tenant_id");

-- CreateIndex
CREATE INDEX "employee_time_off_employee_id_starts_at_idx" ON "employee_time_off"("employee_id", "starts_at");

-- CreateIndex
CREATE INDEX "employee_time_off_tenant_id_idx" ON "employee_time_off"("tenant_id");

-- AddForeignKey
ALTER TABLE "employee_invitations" ADD CONSTRAINT "employee_invitations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_invitations" ADD CONSTRAINT "employee_invitations_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_branches" ADD CONSTRAINT "employee_branches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_branches" ADD CONSTRAINT "employee_branches_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_branches" ADD CONSTRAINT "employee_branches_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_schedules" ADD CONSTRAINT "employee_schedules_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_schedules" ADD CONSTRAINT "employee_schedules_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_schedules" ADD CONSTRAINT "employee_schedules_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_time_off" ADD CONSTRAINT "employee_time_off_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_time_off" ADD CONSTRAINT "employee_time_off_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_time_off" ADD CONSTRAINT "employee_time_off_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- SQL escrito a mano (Prisma no lo genera desde el schema).
-- Si tocás estas tablas, revisá también esta parte.
-- ============================================================================

-- 0 = domingo … 6 = sábado, igual que en branch_business_hours.
ALTER TABLE "employee_schedules"
    ADD CONSTRAINT "employee_schedules_day_of_week_check"
    CHECK ("day_of_week" BETWEEN 0 AND 6);

-- Un tramo de trabajo tiene que terminar después de empezar. A diferencia de
-- branch_business_hours acá no hay "cerrado": un día sin filas es un día que
-- el empleado no trabaja, y varias filas del mismo día son un turno partido.
ALTER TABLE "employee_schedules"
    ADD CONSTRAINT "employee_schedules_range_check"
    CHECK ("ends_at" > "starts_at");

-- Idem para las ausencias, que acá sí son instantes con fecha.
ALTER TABLE "employee_time_off"
    ADD CONSTRAINT "employee_time_off_range_check"
    CHECK ("ends_at" > "starts_at");

-- Una sola invitación viva por empleado: reinvitar revoca la anterior. Sin
-- esto, "la invitación pendiente" sería ambigua y dos links quedarían válidos
-- al mismo tiempo.
CREATE UNIQUE INDEX "employee_invitations_pending_key"
    ON "employee_invitations" ("employee_id")
    WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;
