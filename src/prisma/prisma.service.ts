import {
  Injectable,
  OnModuleInit,
  OnModuleDestroy,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import type { Env } from '../config/env.schema';
import { TenantContextService } from '../common/tenant-context';
import { softDeleteExtension, tenantScopeExtension } from './extensions';
import { TenantPool } from './tenant-pool';

/**
 * Servicio Prisma con dos clientes:
 * - `this` (PrismaClient plano): para health check (Terminus lo necesita),
 *   auth pre-login, seeds y cualquier flow que tenga que hablar con la DB
 *   sin pasar por el scoping de tenant.
 * - `this.scoped`: cliente extendido con soft delete + tenant scope. Esto es
 *   lo que los services de negocio deben usar (ver CLAUDE.md).
 *
 * Regla de oro:
 *   - HealthController, AuthService, seeds, jobs → `prisma.<modelo>`
 *   - Services de negocio (BranchesService, AppointmentsService, etc.) →
 *     `prisma.scoped.<modelo>`
 */
/**
 * El cliente que recibe el callback de `prisma.scoped.$transaction`: el mismo
 * cliente extendido, menos los métodos que adentro de una transacción no se
 * pueden usar. Sirve para tipar helpers que corren dentro de la transacción sin
 * caer en `any`.
 */
export type ScopedTransactionClient = Omit<
  PrismaService['scoped'],
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;

@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  // El `!` es seguro: se inicializa en onModuleInit antes de cualquier consumo.
  private extendedClient!: ReturnType<PrismaService['buildScoped']>;

  private readonly tenantContext: TenantContextService;

  /**
   * El pool que le pasamos al adapter.
   *
   * Se guarda para poder cerrarlo: cuando el pool lo crea el llamador, Prisma
   * **no lo cierra** en `$disconnect()` —y hace bien, no es suyo—, así que sin
   * esto el proceso queda con conexiones abiertas y los tests no terminan.
   */
  private readonly pool: TenantPool;

  constructor(
    configService: ConfigService<Env, true>,
    tenantContext: TenantContextService,
  ) {
    const connectionString = configService.get('DATABASE_URL', { infer: true });

    // El pool es propio para poder ponerle a cada conexión el negocio del
    // request antes de que salga la consulta: es la mitad de RLS que vive del
    // lado de la aplicación (ver `tenant-pool.ts`). Se pasa el parámetro y no
    // `this.tenantContext` porque acá todavía no corrió `super()`.
    const pool = new TenantPool(
      { connectionString },
      () => tenantContext.getTenantId() ?? '',
    );

    super({ adapter: new PrismaPg(pool) });

    this.pool = pool;
    this.tenantContext = tenantContext;
  }

  get scoped(): ReturnType<PrismaService['buildScoped']> {
    return this.extendedClient;
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
    this.extendedClient = this.buildScoped();
    this.logger.log(
      'Connected to database with soft-delete and tenant-scope extensions',
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
    await this.pool.end();
  }

  private buildScoped() {
    return this.$extends(softDeleteExtension).$extends(
      tenantScopeExtension(this.tenantContext),
    );
  }
}
