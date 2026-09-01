-- AlterTable
--
-- Los tres nacen con default y NOT NULL: no hay backfill que hacer y ningún
-- negocio ya cargado queda con la ventana de reserva en cero, que sería un
-- portal que no acepta nada.
ALTER TABLE "tenant_settings"
    ADD COLUMN "public_booking_enabled" BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN "min_booking_notice_minutes" INTEGER NOT NULL DEFAULT 120,
    ADD COLUMN "max_booking_days_ahead" INTEGER NOT NULL DEFAULT 60;

-- AlterTable
ALTER TABLE "services"
    ADD COLUMN "publicly_bookable" BOOLEAN NOT NULL DEFAULT true;

-- La ventana de reserva tiene que describir una ventana que exista.
--
-- El piso puede ser 0 ("se reserva hasta último momento"), pero el techo no:
-- con `max_booking_days_ahead = 0` no hay ningún día reservable y el portal
-- contestaría siempre vacío, que se lee como un bug y no como una decisión.
-- El tope de 730 días es defensivo: dos años ya no es una agenda.
ALTER TABLE "tenant_settings"
    ADD CONSTRAINT "tenant_settings_booking_window_valid"
    CHECK ("min_booking_notice_minutes" >= 0
        AND "max_booking_days_ahead" BETWEEN 1 AND 730);
