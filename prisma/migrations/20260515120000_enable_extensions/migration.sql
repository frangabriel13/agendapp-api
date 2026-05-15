-- Habilita extensiones de Postgres que vamos a necesitar a lo largo del proyecto.
-- pgcrypto:   gen_random_uuid() para IDs UUID v4 en todas las tablas de negocio.
-- btree_gist: requerido por los EXCLUDE USING gist de la Fase 5 (appointments
--             y appointment_resources) para prevenir doble-booking.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "btree_gist";
