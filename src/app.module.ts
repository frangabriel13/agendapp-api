import { randomUUID } from 'node:crypto';
import {
  Module,
  RequestMethod,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import {
  TenantContextMiddleware,
  TenantContextModule,
} from './common/tenant-context';
import { RolesGuard } from './common/guards/roles.guard';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { HealthModule } from './modules/health/health.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { validateEnv } from './config/env.validation';
import type { Env } from './config/env.schema';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
    }),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => {
        const env = config.get('NODE_ENV', { infer: true });
        const isProd = env === 'production';
        return {
          pinoHttp: {
            level: isProd ? 'info' : 'debug',
            transport: isProd
              ? undefined
              : {
                  target: 'pino-pretty',
                  options: { singleLine: true, translateTime: 'SYS:HH:MM:ss' },
                },
            genReqId: (req) => {
              const incoming = req.headers['x-request-id'];
              if (typeof incoming === 'string' && incoming.length > 0)
                return incoming;
              return randomUUID();
            },
            customProps: (req) => ({ requestId: (req as { id?: string }).id }),
          },
        };
      },
    }),
    ThrottlerModule.forRoot([
      { name: 'short', ttl: 1_000, limit: 10 },
      { name: 'long', ttl: 60_000, limit: 100 },
    ]),
    TenantContextModule,
    PrismaModule,
    AuthModule,
    HealthModule,
    TenantsModule,
  ],
  controllers: [],
  providers: [
    // El orden importa: primero se corta por rate limit, después se autentica.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Guard global: todo endpoint nace protegido; se abre con `@Public()`.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Autorización por rol. Va último: necesita el `request.user` del anterior.
    // No hace nada salvo que el handler declare `@Roles(...)`.
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  /**
   * El middleware de tenant-context va sobre TODAS las rutas y tiene que correr
   * antes que cualquier guard — por eso es middleware y no interceptor.
   * `{*path}` es la sintaxis de wildcard de Express 5 (Nest 11); el viejo `'*'`
   * sigue funcionando pero emite un warning de deprecación.
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(TenantContextMiddleware)
      .forRoutes({ path: '{*path}', method: RequestMethod.ALL });
  }
}
