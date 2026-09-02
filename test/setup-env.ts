import 'dotenv/config';
import { restrictedTestDatabaseUrl } from './utils/test-database';

/**
 * Corre antes de cada archivo de tests: apunta la app a la base de e2e.
 *
 * `dotenv` no pisa variables ya definidas, así que el `ConfigModule` de Nest va
 * a tomar esta connection string y no la del `.env`.
 *
 * ⚠️ **Va con el rol restringido, no con el dueño.** Un superusuario ignora RLS
 * —`FORCE` incluido—, así que corriendo con el de siempre las políticas
 * existirían y no cortarían nada, y la suite entera pasaría en verde sin
 * probarlas. El rol lo crea `global-setup`, que también corre las migraciones
 * con el dueño porque este no puede hacer DDL.
 */
process.env.DATABASE_URL = restrictedTestDatabaseUrl();
process.env.NODE_ENV = 'test';
