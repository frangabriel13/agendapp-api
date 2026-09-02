import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import {
  maintenanceDatabaseUrl,
  RLS_TEST_PASSWORD,
  RLS_TEST_ROLE,
  testDatabaseName,
  testDatabaseUrl,
} from './utils/test-database';

/**
 * Prepara la base de e2e una sola vez por corrida:
 *   1. la crea si no existe,
 *   2. aplica las migraciones (`migrate deploy`, no `dev`: no toca el historial),
 *   3. carga el seed de planes, que `POST /auth/register` necesita sí o sí.
 *
 * Los datos de negocio los limpia cada archivo de tests con `resetDatabase()`;
 * `plans` sobrevive porque es catálogo global.
 */
export default async function globalSetup(): Promise<void> {
  const url = testDatabaseUrl();
  const name = testDatabaseName();

  const admin = new Client({ connectionString: maintenanceDatabaseUrl() });
  await admin.connect();

  try {
    const existing = await admin.query(
      'SELECT 1 FROM pg_database WHERE datname = $1',
      [name],
    );

    if (existing.rowCount === 0) {
      // El nombre sale de nuestra propia connection string, no de input externo.
      await admin.query(`CREATE DATABASE "${name}"`);
      console.log(`[e2e] base de tests creada: ${name}`);
    }
  } finally {
    await admin.end();
  }

  const env = { ...process.env, DATABASE_URL: url };
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], { env, stdio: 'pipe' });
  execFileSync('npx', ['prisma', 'db', 'seed'], { env, stdio: 'pipe' });

  await grantRlsRole(url);

  process.env.DATABASE_URL = url;
}

/**
 * Deja listo el rol con el que la app va a correr en los tests.
 *
 * Es lo que hace que RLS se pruebe de verdad: el rol dueño de las tablas
 * ignora las políticas (`FORCE` incluido), así que con él la suite pasaría
 * entera sin que ninguna cortara nada. Con este rol, **cada e2e que ya existe**
 * es además una prueba de que el aislamiento de la base no rompe la aplicación.
 *
 * `TRUNCATE` va en la lista porque es lo que usa `resetDatabase()` entre
 * archivos. RLS no aplica a `TRUNCATE` —es una operación de tabla, no de
 * filas— así que darlo no abre ningún agujero en lo que se está probando.
 */
async function grantRlsRole(url: string): Promise<void> {
  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    const existing = await client.query(
      'SELECT 1 FROM pg_roles WHERE rolname = $1',
      [RLS_TEST_ROLE],
    );

    if (existing.rowCount === 0) {
      await client.query(
        `CREATE ROLE "${RLS_TEST_ROLE}" LOGIN PASSWORD '${RLS_TEST_PASSWORD}'`,
      );
    }

    // Idempotente y barato: se vuelven a otorgar en cada corrida porque una
    // migración nueva trae tablas que el rol todavía no tenía.
    await client.query(`GRANT USAGE ON SCHEMA public TO "${RLS_TEST_ROLE}"`);
    await client.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public TO "${RLS_TEST_ROLE}"`,
    );
    await client.query(
      `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO "${RLS_TEST_ROLE}"`,
    );
  } finally {
    await client.end();
  }
}
