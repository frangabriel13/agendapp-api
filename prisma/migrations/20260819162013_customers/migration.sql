-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "first_name" VARCHAR(100) NOT NULL,
    "last_name" VARCHAR(100),
    "phone" VARCHAR(30) NOT NULL,
    "phone_normalized" VARCHAR(30) NOT NULL,
    "email" VARCHAR(255),
    "date_of_birth" DATE,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_tags" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "color" VARCHAR(7),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "customer_tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_tag_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_tag_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customers_tenant_id_idx" ON "customers"("tenant_id");

-- CreateIndex
CREATE INDEX "customers_tenant_id_phone_normalized_idx" ON "customers"("tenant_id", "phone_normalized");

-- CreateIndex
CREATE INDEX "customers_tenant_id_email_idx" ON "customers"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "customer_tags_tenant_id_idx" ON "customer_tags"("tenant_id");

-- CreateIndex
CREATE INDEX "customer_tag_assignments_tenant_id_idx" ON "customer_tag_assignments"("tenant_id");

-- CreateIndex
CREATE INDEX "customer_tag_assignments_tag_id_idx" ON "customer_tag_assignments"("tag_id");

-- CreateIndex
CREATE UNIQUE INDEX "customer_tag_assignments_customer_id_tag_id_key" ON "customer_tag_assignments"("customer_id", "tag_id");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_tags" ADD CONSTRAINT "customer_tags_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_tag_assignments" ADD CONSTRAINT "customer_tag_assignments_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_tag_assignments" ADD CONSTRAINT "customer_tag_assignments_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_tag_assignments" ADD CONSTRAINT "customer_tag_assignments_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "customer_tags"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- SQL escrito a mano (Prisma no lo genera desde el schema).
-- Si tocás estas tablas, revisá también esta parte.
-- ============================================================================

-- La regla que sostiene toda la fase: un teléfono, un cliente. Es lo único que
-- el mostrador siempre pide, y es lo que permite reconocer a alguien que vuelve.
-- `CustomersService.create` consulta antes para poder devolver un 409 con la
-- ficha existente; este índice es la red por si dos altas entran a la vez.
--
-- Compara `phone_normalized` (solo dígitos, ver `normalizePhone`) y no `phone`,
-- porque si no "+54 9 11 1234-5678" y "1112345678" serían dos personas.
-- Parcial: dar de baja un cliente libera su teléfono para uno nuevo.
CREATE UNIQUE INDEX "customers_tenant_id_phone_active_key"
    ON "customers" ("tenant_id", "phone_normalized")
    WHERE "deleted_at" IS NULL;

-- El email NO es único a propósito: una madre y su hija comparten casilla más
-- seguido de lo que uno esperaría, y rechazar el alta por eso sería un bug de
-- mostrador. El índice de arriba (generado por Prisma) es solo para buscar.

ALTER TABLE "customers"
    ADD CONSTRAINT "customers_first_name_not_blank_check"
    CHECK (length(btrim("first_name")) > 0);

ALTER TABLE "customers"
    ADD CONSTRAINT "customers_phone_not_blank_check"
    CHECK (length(btrim("phone")) > 0 AND length(btrim("phone_normalized")) > 0);

-- Nadie nació antes de 1900 ni en el futuro. El techo real ("no después de
-- hoy") no se puede poner acá: CURRENT_DATE no es IMMUTABLE y un CHECK no lo
-- admite. Ese lo valida el DTO.
ALTER TABLE "customers"
    ADD CONSTRAINT "customers_date_of_birth_check"
    CHECK ("date_of_birth" IS NULL OR "date_of_birth" >= DATE '1900-01-01');

-- Etiquetas: mismo criterio que las categorías de servicios. Únicas por negocio
-- e insensibles a mayúsculas, para que no convivan "VIP" y "Vip".
CREATE UNIQUE INDEX "customer_tags_tenant_id_name_active_key"
    ON "customer_tags" ("tenant_id", lower("name"))
    WHERE "deleted_at" IS NULL;

ALTER TABLE "customer_tags"
    ADD CONSTRAINT "customer_tags_name_not_blank_check"
    CHECK (length(btrim("name")) > 0);

ALTER TABLE "customer_tags"
    ADD CONSTRAINT "customer_tags_color_format_check"
    CHECK ("color" IS NULL OR "color" ~ '^#[0-9A-Fa-f]{6}$');
