-- CreateEnum
CREATE TYPE "time_off_kind" AS ENUM ('vacation', 'leave', 'other');

-- AlterTable
--
-- Con `DEFAULT 'other'` la columna nace NOT NULL sin backfill a mano y sin
-- romper a quien ya venía cargando ausencias sin el campo: una ausencia vieja
-- es exactamente eso, una de la que no sabemos la clase.
ALTER TABLE "employee_time_off" ADD COLUMN "kind" "time_off_kind" NOT NULL DEFAULT 'other';
