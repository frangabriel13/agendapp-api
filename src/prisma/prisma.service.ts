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
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  // El `!` es seguro: se inicializa en onModuleInit antes de cualquier consumo.
  private extendedClient!: ReturnType<PrismaService['buildScoped']>;

  constructor(
    configService: ConfigService<Env, true>,
    private readonly tenantContext: TenantContextService,
  ) {
    const connectionString = configService.get('DATABASE_URL', { infer: true });
    super({
      adapter: new PrismaPg({ connectionString }),
    });
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
  }

  private buildScoped() {
    return this.$extends(softDeleteExtension).$extends(
      tenantScopeExtension(this.tenantContext),
    );
  }
}
