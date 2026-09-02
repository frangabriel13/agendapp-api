-- CreateEnum
CREATE TYPE "note_entity_type" AS ENUM ('customer', 'appointment', 'employee', 'branch', 'general');

-- CreateTable
CREATE TABLE "notes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenant_id" UUID NOT NULL,
    "author_user_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "is_private" BOOLEAN NOT NULL DEFAULT false,
    "entity_type" "note_entity_type" NOT NULL,
    "entity_id" UUID,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notes_tenant_id_entity_type_entity_id_idx" ON "notes"("tenant_id", "entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "notes_tenant_id_created_at_idx" ON "notes"("tenant_id", "created_at");

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_author_user_id_fkey" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Las dos mitades del polimorfismo, atadas en la base.
--
-- `general` es la nota del negocio y va sin destino; cualquier otro tipo lo
-- exige. Escrito a mano porque Prisma no representa CHECKs: si esto viviera
-- solo en el DTO, una nota cargada por un seed o un import quedaría con un
-- tipo que apunta a nada y la lista por entidad nunca la encontraría.
ALTER TABLE "notes"
    ADD CONSTRAINT "notes_entity_target_valid"
    CHECK (
        ("entity_type" = 'general' AND "entity_id" IS NULL)
        OR ("entity_type" <> 'general' AND "entity_id" IS NOT NULL)
    );

-- Una nota vacía no es una nota.
ALTER TABLE "notes"
    ADD CONSTRAINT "notes_content_not_blank"
    CHECK (length(btrim("content")) > 0);
