import 'dotenv/config';
import { testDatabaseUrl } from './utils/test-database';

/**
 * Corre antes de cada archivo de tests: apunta la app a la base de e2e.
 *
 * `dotenv` no pisa variables ya definidas, así que el `ConfigModule` de Nest va
 * a tomar esta connection string y no la del `.env`.
 */
process.env.DATABASE_URL = testDatabaseUrl();
process.env.NODE_ENV = 'test';
