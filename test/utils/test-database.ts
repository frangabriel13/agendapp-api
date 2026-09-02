import 'dotenv/config';

/**
 * Los e2e NO corren contra la base de desarrollo: usan una hermana con sufijo
 * `_test` en el mismo Postgres, que se crea, migra y siembra sola en el
 * `globalSetup`. Así los tests pueden truncar tablas sin borrarte los datos con
 * los que venías probando a mano.
 *
 * Se puede apuntar a otra base con `E2E_DATABASE_URL` (útil para CI).
 */
const TEST_SUFFIX = '_test';

function baseUrl(): URL {
  const raw = process.env.E2E_DATABASE_URL ?? process.env.DATABASE_URL;

  if (!raw) {
    throw new Error(
      'Falta DATABASE_URL (o E2E_DATABASE_URL) para levantar la base de tests',
    );
  }

  return new URL(raw);
}

export function testDatabaseUrl(): string {
  const url = baseUrl();
  const name = url.pathname.replace(/^\//, '');

  if (!name) {
    throw new Error(`La connection string no incluye una base: ${url.host}`);
  }

  // Idempotente: si ya apunta a la base de tests, se devuelve tal cual.
  url.pathname = name.endsWith(TEST_SUFFIX)
    ? `/${name}`
    : `/${name}${TEST_SUFFIX}`;

  return url.toString();
}

export function testDatabaseName(): string {
  return new URL(testDatabaseUrl()).pathname.replace(/^\//, '');
}

/** Conexión a la base `postgres` del mismo server, para poder crear la de tests. */
export function maintenanceDatabaseUrl(): string {
  const url = new URL(testDatabaseUrl());
  url.pathname = '/postgres';
  url.search = '';
  return url.toString();
}

/**
 * El rol con el que la app corre en los e2e: **sin superusuario y sin
 * BYPASSRLS**, para que las políticas de RLS efectivamente corten.
 *
 * No es un detalle del harness: con el rol dueño de las tablas, Postgres ignora
 * RLS por completo (`FORCE` incluido) y toda la suite pasaría en verde sin que
 * ninguna política estuviera haciendo nada. Corriendo así, cada uno de los
 * cientos de e2e que ya existen es también una prueba de que RLS no rompe
 * nada.
 *
 * Las migraciones y el seed siguen corriendo con el rol dueño, en el
 * `globalSetup`: este rol no puede hacer DDL a propósito.
 */
export const RLS_TEST_ROLE = 'agendapp_e2e';

/** Solo para la base de tests local. No hay nada que proteger acá. */
export const RLS_TEST_PASSWORD = 'agendapp_e2e';

export function restrictedTestDatabaseUrl(): string {
  const url = new URL(testDatabaseUrl());

  url.username = RLS_TEST_ROLE;
  url.password = RLS_TEST_PASSWORD;

  return url.toString();
}
