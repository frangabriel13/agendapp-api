-- CreateTable
CREATE TABLE "service_categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "service_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "services" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "category_id" UUID,
    "name" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "duration_minutes" INTEGER NOT NULL,
    "price_cents" INTEGER NOT NULL,
    "deposit_amount_cents" INTEGER,
    "buffer_after_minutes" INTEGER NOT NULL DEFAULT 0,
    "color" VARCHAR(7),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "services_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "employee_services" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "service_id" UUID NOT NULL,
    "branch_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "employee_services_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "service_categories_tenant_id_idx" ON "service_categories"("tenant_id");

-- CreateIndex
CREATE INDEX "services_tenant_id_idx" ON "services"("tenant_id");

-- CreateIndex
CREATE INDEX "services_category_id_idx" ON "services"("category_id");

-- CreateIndex
CREATE INDEX "employee_services_tenant_id_idx" ON "employee_services"("tenant_id");

-- CreateIndex
CREATE INDEX "employee_services_service_id_idx" ON "employee_services"("service_id");

-- CreateIndex
CREATE INDEX "employee_services_branch_id_idx" ON "employee_services"("branch_id");

-- CreateIndex
CREATE UNIQUE INDEX "employee_services_employee_id_service_id_branch_id_key" ON "employee_services"("employee_id", "service_id", "branch_id");

-- AddForeignKey
ALTER TABLE "service_categories" ADD CONSTRAINT "service_categories_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "services" ADD CONSTRAINT "services_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "service_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_services" ADD CONSTRAINT "employee_services_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_services" ADD CONSTRAINT "employee_services_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_services" ADD CONSTRAINT "employee_services_service_id_fkey" FOREIGN KEY ("service_id") REFERENCES "services"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "employee_services" ADD CONSTRAINT "employee_services_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- SQL escrito a mano (Prisma no lo genera desde el schema).
-- Si tocás estas tablas, revisá también esta parte.
-- ============================================================================

-- Mismo criterio que en sucursales: dos categorías con el mismo nombre no se
-- distinguen al agendar. Parcial para que borrar una libere el nombre, y sobre
-- lower(name) para que "Color" y "color" cuenten como la misma.
CREATE UNIQUE INDEX "service_categories_tenant_id_name_active_key"
    ON "service_categories" ("tenant_id", lower("name"))
    WHERE "deleted_at" IS NULL;

ALTER TABLE "service_categories"
    ADD CONSTRAINT "service_categories_name_not_blank_check"
    CHECK (length(btrim("name")) > 0);

ALTER TABLE "service_categories"
    ADD CONSTRAINT "service_categories_display_order_check"
    CHECK ("display_order" >= 0);

-- A propósito NO hay unique de nombre en `services`: un negocio puede tener
-- "Corte" en la categoría Damas y otro "Corte" en Caballeros, con precios
-- distintos. Es un caso real, no un error de carga.
ALTER TABLE "services"
    ADD CONSTRAINT "services_name_not_blank_check"
    CHECK (length(btrim("name")) > 0);

-- Un servicio de 0 minutos no genera ningún slot en la Fase 5, y uno de más de
-- un día no es un turno. El buffer sí puede ser 0 (lo normal).
ALTER TABLE "services"
    ADD CONSTRAINT "services_duration_check"
    CHECK ("duration_minutes" > 0 AND "duration_minutes" <= 1440);

ALTER TABLE "services"
    ADD CONSTRAINT "services_buffer_check"
    CHECK ("buffer_after_minutes" >= 0 AND "buffer_after_minutes" <= 1440);

-- Precio 0 es válido (una consulta sin cargo). Negativo no.
ALTER TABLE "services"
    ADD CONSTRAINT "services_price_check"
    CHECK ("price_cents" >= 0);

-- La seña es opcional (null = sin seña), pero si está no puede superar al
-- precio ni ser negativa: cobrar de seña más que el total no tiene sentido.
ALTER TABLE "services"
    ADD CONSTRAINT "services_deposit_check"
    CHECK (
        "deposit_amount_cents" IS NULL
     OR ("deposit_amount_cents" >= 0 AND "deposit_amount_cents" <= "price_cents")
    );

-- El color va directo al calendario del front como CSS. Formato #RRGGBB.
ALTER TABLE "services"
    ADD CONSTRAINT "services_color_format_check"
    CHECK ("color" IS NULL OR "color" ~ '^#[0-9A-Fa-f]{6}$');
