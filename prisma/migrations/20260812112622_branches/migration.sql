-- CreateTable
CREATE TABLE "branches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "address" VARCHAR(255),
    "phone" VARCHAR(30),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch_business_hours" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "day_of_week" SMALLINT NOT NULL,
    "opens_at" TIME(0),
    "closes_at" TIME(0),
    "is_closed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "branch_business_hours_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branch_special_days" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "date" DATE NOT NULL,
    "is_closed" BOOLEAN NOT NULL DEFAULT true,
    "opens_at" TIME(0),
    "closes_at" TIME(0),
    "description" VARCHAR(255),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "branch_special_days_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "branches_tenant_id_idx" ON "branches"("tenant_id");

-- CreateIndex
CREATE INDEX "branch_business_hours_tenant_id_idx" ON "branch_business_hours"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "branch_business_hours_branch_id_day_of_week_key" ON "branch_business_hours"("branch_id", "day_of_week");

-- CreateIndex
CREATE INDEX "branch_special_days_tenant_id_idx" ON "branch_special_days"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "branch_special_days_branch_id_date_key" ON "branch_special_days"("branch_id", "date");

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_business_hours" ADD CONSTRAINT "branch_business_hours_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_business_hours" ADD CONSTRAINT "branch_business_hours_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_special_days" ADD CONSTRAINT "branch_special_days_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branch_special_days" ADD CONSTRAINT "branch_special_days_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- SQL escrito a mano (Prisma no lo genera desde el schema).
-- Si tocás estas tablas, revisá también esta parte.
-- ============================================================================

-- Dos sucursales con el mismo nombre en el mismo negocio son un problema de
-- usabilidad (al agendar no se distinguen). El índice es PARCIAL para que
-- borrar una sucursal libere el nombre, y sobre lower(name) para que "Centro"
-- y "centro" cuenten como el mismo.
CREATE UNIQUE INDEX "branches_tenant_id_name_active_key"
    ON "branches" ("tenant_id", lower("name"))
    WHERE "deleted_at" IS NULL;

-- Un nombre en blanco pasa el NOT NULL pero no sirve para nada.
ALTER TABLE "branches"
    ADD CONSTRAINT "branches_name_not_blank_check"
    CHECK (length(btrim("name")) > 0);

-- 0 = domingo … 6 = sábado.
ALTER TABLE "branch_business_hours"
    ADD CONSTRAINT "branch_business_hours_day_of_week_check"
    CHECK ("day_of_week" BETWEEN 0 AND 6);

-- Un día cerrado va sin horas; uno abierto las exige y en orden. Es todo o
-- nada: así no queda un día "abierto" sin horario, que en la Fase 5 sería un
-- día sin turnos disponibles pero sin explicación.
ALTER TABLE "branch_business_hours"
    ADD CONSTRAINT "branch_business_hours_hours_check"
    CHECK (
        ("is_closed" = true  AND "opens_at" IS NULL AND "closes_at" IS NULL)
     OR ("is_closed" = false AND "opens_at" IS NOT NULL AND "closes_at" IS NOT NULL
         AND "closes_at" > "opens_at")
    );

-- Misma regla para las excepciones puntuales (feriados y jornadas especiales).
ALTER TABLE "branch_special_days"
    ADD CONSTRAINT "branch_special_days_hours_check"
    CHECK (
        ("is_closed" = true  AND "opens_at" IS NULL AND "closes_at" IS NULL)
     OR ("is_closed" = false AND "opens_at" IS NOT NULL AND "closes_at" IS NOT NULL
         AND "closes_at" > "opens_at")
    );
