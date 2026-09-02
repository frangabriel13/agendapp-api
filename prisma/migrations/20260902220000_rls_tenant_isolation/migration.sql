-- Aislamiento entre negocios, del lado de Postgres.
--
-- La red de seguridad final: la extension de Prisma ya filtra por `tenant_id`
-- en cada consulta, y esto es lo que tapa el dia que esa extension tenga un bug,
-- o que alguien use el cliente base y se olvide del filtro.
--
-- ATENCION: TRES COSAS QUE HAY QUE SABER O ESTO NO SIRVE PARA NADA
--
-- 1. Un SUPERUSUARIO IGNORA RLS, y `FORCE ROW LEVEL SECURITY` tampoco lo
--    alcanza. Mientras la app se conecte con el rol duenio de la base (hoy
--    `agendapp`, que es superusuario), estas politicas existen y no cortan
--    nada. La otra mitad del trabajo es de despliegue: crear `agendapp_app`
--    -sin BYPASSRLS, sin SUPERUSER- y apuntar ahi `DATABASE_URL`. Esta en el
--    README. Verificado midiendo: con el rol duenio, un negocio ve las
--    sucursales del otro aunque la politica este puesta.
--
-- 2. `FORCE` es necesario igual, porque el duenio de una tabla esta exento de
--    sus propias politicas aunque no sea superusuario. Sin `FORCE`, el dia que
--    las migraciones y la app compartan rol, esto vuelve a ser decorado.
--
-- 3. El `nullif` va TAMBIEN adentro del cast. Postgres NO garantiza
--    cortocircuito en un `OR`: con el setting vacio evalua igual el `::uuid` y
--    revienta con `invalid input syntax for type uuid: ""` en CADA consulta.
--    Es un error que aparece al primer request, no al probar la politica.
--
-- El setting vacio deja ver todo. No es un descuido: es la misma puerta que
-- `runWithoutTenant()` en la aplicacion -login, webhooks, jobs, seeds- y el
-- mismo trato de confianza que el repo ya tiene. RLS aca protege contra
-- nuestros propios bugs, no contra alguien que ya puede escribir SQL a mano.
--
-- El nombre del setting tiene que decir lo mismo que `TENANT_SETTING` en
-- `src/prisma/tenant-pool.ts`. Si divergen, las politicas no encuentran el
-- valor y pasan a dejar ver todo, en silencio.

ALTER TABLE "appointment_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointment_payments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "appointment_payments"
    USING (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    )
    WITH CHECK (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    );

ALTER TABLE "appointment_reminders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointment_reminders" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "appointment_reminders"
    USING (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    )
    WITH CHECK (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    );

ALTER TABLE "appointment_resources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointment_resources" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "appointment_resources"
    USING (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    )
    WITH CHECK (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    );

ALTER TABLE "appointment_services" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointment_services" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "appointment_services"
    USING (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    )
    WITH CHECK (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    );

ALTER TABLE "appointments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "appointments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "appointments"
    USING (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    )
    WITH CHECK (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    );

ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "audit_logs"
    USING (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    )
    WITH CHECK (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    );

ALTER TABLE "branch_business_hours" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "branch_business_hours" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "branch_business_hours"
    USING (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    )
    WITH CHECK (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    );

ALTER TABLE "branch_special_days" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "branch_special_days" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "branch_special_days"
    USING (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    )
    WITH CHECK (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    );

ALTER TABLE "branches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "branches" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "branches"
    USING (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    )
    WITH CHECK (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    );

ALTER TABLE "customer_tag_assignments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_tag_assignments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "customer_tag_assignments"
    USING (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    )
    WITH CHECK (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    );

ALTER TABLE "customer_tags" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customer_tags" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "customer_tags"
    USING (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    )
    WITH CHECK (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    );

ALTER TABLE "customers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "customers" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "customers"
    USING (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    )
    WITH CHECK (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    );

ALTER TABLE "employee_branches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "employee_branches" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "employee_branches"
    USING (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    )
    WITH CHECK (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    );

ALTER TABLE "employee_invitations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "employee_invitations" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "employee_invitations"
    USING (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    )
    WITH CHECK (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    );

ALTER TABLE "employee_schedules" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "employee_schedules" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "employee_schedules"
    USING (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    )
    WITH CHECK (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    );

ALTER TABLE "employee_services" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "employee_services" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "employee_services"
    USING (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    )
    WITH CHECK (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    );

ALTER TABLE "employee_time_off" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "employee_time_off" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "employee_time_off"
    USING (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    )
    WITH CHECK (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    );

ALTER TABLE "employees" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "employees" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "employees"
    USING (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    )
    WITH CHECK (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    );

ALTER TABLE "notes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notes" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "notes"
    USING (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    )
    WITH CHECK (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    );

ALTER TABLE "recurrence_groups" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recurrence_groups" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "recurrence_groups"
    USING (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    )
    WITH CHECK (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    );

ALTER TABLE "resources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resources" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "resources"
    USING (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    )
    WITH CHECK (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    );

ALTER TABLE "service_categories" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_categories" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "service_categories"
    USING (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    )
    WITH CHECK (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    );

ALTER TABLE "service_resources" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_resources" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "service_resources"
    USING (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    )
    WITH CHECK (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    );

ALTER TABLE "services" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "services" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "services"
    USING (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    )
    WITH CHECK (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    );

ALTER TABLE "subscription_payments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subscription_payments" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "subscription_payments"
    USING (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    )
    WITH CHECK (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    );

ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subscriptions" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "subscriptions"
    USING (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    )
    WITH CHECK (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    );

ALTER TABLE "tenant_branding" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_branding" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tenant_branding"
    USING (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    )
    WITH CHECK (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    );

ALTER TABLE "tenant_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenant_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tenant_settings"
    USING (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    )
    WITH CHECK (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "tenant_id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    );

-- `tenants` no tiene columna `tenant_id`: EL es el tenant, asi que la
-- politica compara contra su propio `id`. Es el mismo criterio que usa la
-- extension de Prisma, que para este modelo filtra por `id`.
ALTER TABLE "tenants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "tenants" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "tenants"
    USING (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    )
    WITH CHECK (
        nullif(current_setting('app.current_tenant', true), '') IS NULL
        OR "id" = nullif(current_setting('app.current_tenant', true), '')::uuid
    );

-- Los permisos del rol de la aplicacion, si ya existe.
--
-- Va en un `DO` y no suelto porque el rol es de CLUSTER, no de base: en
-- desarrollo puede no estar creado todavia, y una migracion que falle por eso
-- dejaria el schema a medio aplicar. Crear el rol es un paso de despliegue
-- documentado en el README -- meterlo aca pondria una contrasenia en el
-- repositorio y le exigiria permisos de superusuario a `migrate deploy`.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agendapp_app') THEN
        GRANT USAGE ON SCHEMA public TO agendapp_app;
        GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO agendapp_app;
        GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO agendapp_app;
    END IF;
END
$$;
