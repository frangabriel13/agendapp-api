/**
 * Crea el rol con el que la aplicación debería conectarse en producción.
 *
 * Existe como script y no como migración por dos motivos: un rol es de
 * **cluster** y no de base (una migración de schema no es su lugar), y crearlo
 * ahí metería una contraseña en el repositorio y le exigiría permisos de
 * superusuario a `prisma migrate deploy`.
 *
 * Uso:
 *   RLS_ROLE_PASSWORD=... npm run db:rls-role
 *
 * Se conecta con la `DATABASE_URL` actual, que tiene que ser la del rol dueño.
 */
import { Client } from 'pg';
import 'dotenv/config';

const ROLE = process.env.RLS_ROLE ?? 'agendapp_app';
const PASSWORD = process.env.RLS_ROLE_PASSWORD;

if (!PASSWORD) {
  console.error(
    'Falta RLS_ROLE_PASSWORD. Ejemplo:\n' +
      "  RLS_ROLE_PASSWORD='...' npm run db:rls-role",
  );
  process.exit(1);
}

const url = process.env.DATABASE_URL;

if (!url) {
  console.error('Falta DATABASE_URL.');
  process.exit(1);
}

const client = new Client({ connectionString: url });
await client.connect();

try {
  const { rowCount } = await client.query(
    'SELECT 1 FROM pg_roles WHERE rolname = $1',
    [ROLE],
  );

  // `CREATE ROLE` y `ALTER ROLE` son sentencias de utilidad: **no aceptan
  // parámetros**, así que el nombre y la contraseña hay que interpolarlos. Se
  // arma la sentencia con `format('%I', ...)` / `format('%L', ...)`, que es el
  // escapado del propio Postgres, en vez de comillas puestas a mano.
  const statement = async (template) => {
    // Los `::text` no son adorno: `format` es variádica sobre `"any"` y sin
    // los casts Postgres no puede inferir el tipo de los parámetros.
    const { rows } = await client.query(
      'SELECT format($1::text, $2::text, $3::text) AS sql',
      [
        template,
        ROLE,
        PASSWORD,
      ],
    );

    await client.query(rows[0].sql);
  };

  if (rowCount === 0) {
    await statement('CREATE ROLE %I LOGIN PASSWORD %L');
    console.log(`Rol ${ROLE} creado.`);
  } else {
    await statement('ALTER ROLE %I WITH LOGIN PASSWORD %L');
    console.log(`Rol ${ROLE} ya existía: se le actualizó la contraseña.`);
  }

  // Ni SUPERUSER ni BYPASSRLS: es todo el punto del rol. Se fuerza por si el
  // rol venía de antes con privilegios de más.
  await client.query(`ALTER ROLE "${ROLE}" NOSUPERUSER NOBYPASSRLS NOCREATEDB`);

  await client.query(`GRANT USAGE ON SCHEMA public TO "${ROLE}"`);
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO "${ROLE}"`,
  );
  await client.query(
    `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${ROLE}"`,
  );

  // Para las tablas que traigan las migraciones futuras: sin esto, cada
  // migración nueva dejaría una tabla que la app no puede leer.
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public
     GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "${ROLE}"`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES IN SCHEMA public
     GRANT USAGE, SELECT ON SEQUENCES TO "${ROLE}"`,
  );

  const target = new URL(url);
  target.username = ROLE;
  target.password = '***';

  console.log('\nListo. Apuntá DATABASE_URL de la app a:\n  ' + target.toString());
  console.log(
    '\nLas migraciones y los seeds siguen yendo con el rol dueño: este no hace DDL.',
  );
} finally {
  await client.end();
}
