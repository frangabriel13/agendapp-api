import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { Client } from 'pg';
import {
  maintenanceDatabaseUrl,
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

  process.env.DATABASE_URL = url;
}
