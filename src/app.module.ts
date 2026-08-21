import { randomUUID } from 'node:crypto';
import {
  Module,
  RequestMethod,
  ValidationPipe,
  type MiddlewareConsumer,
  type NestModule,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_FILTER, APP_GUARD, APP_PIPE } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import {
  TenantContextMiddleware,
  TenantContextModule,
} from './common/tenant-context';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ActiveSubscriptionGuard } from './common/guards/active-subscription.guard';
import { RolesGuard } from './common/guards/roles.guard';
import { MailModule } from './common/mail';
import { PrismaModule } from './prisma/prisma.module';
import { AppointmentsModule } from './modules/appointments/appointments.module';
import { AuthModule } from './modules/auth/auth.module';
import { BranchesModule } from './modules/branches/branches.module';
import { CustomerTagsModule } from './modules/customer-tags/customer-tags.module';
import { CustomersModule } from './modules/customers/customers.module';
import { EmployeesModule } from './modules/employees/employees.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { SubscriptionsModule } from './modules/subscriptions/subscriptions.module';
import { ResourcesModule } from './modules/resources/resources.module';
import { ServiceCategoriesModule } from './modules/service-categories/service-categories.module';
import { ServicesModule } from './modules/services/services.module';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';
import { HealthModule } from './modules/health/health.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { validateEnv } from './config/env.validation';
import { THROTTLERS } from './config/throttler.config';
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
            // En test se silencia: si no, cada request de los e2e escupe un log.
            level: isProd ? 'info' : env === 'test' ? 'silent' : 'debug',
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
    // La lista vive en su propio archivo porque `main.ts` la necesita para
    // saber qué headers de rate limit exponer por CORS.
    ThrottlerModule.forRoot(THROTTLERS),
    // Habilita los `@Cron(...)`. Hoy lo usa solo el vencimiento de
    // suscripciones. Ojo: los jobs corren en CADA instancia de la app, así que
    // todo lo que se agregue tiene que ser idempotente.
    ScheduleModule.forRoot(),
    TenantContextModule,
    PrismaModule,
    MailModule,
    AuthModule,
    HealthModule,
    TenantsModule,
    BranchesModule,
    EmployeesModule,
    ServiceCategoriesModule,
    ServicesModule,
    ResourcesModule,
    CustomersModule,
    CustomerTagsModule,
    AppointmentsModule,
    SubscriptionsModule,
    PaymentsModule,
  ],
  controllers: [],
  providers: [
    // Pipe y filtro globales como providers (no en main.ts) para que los tests
    // e2e levanten la app con el mismo comportamiento que producción.
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
      }),
    },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // El orden importa: primero se corta por rate limit, después se autentica.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    // Guard global: todo endpoint nace protegido; se abre con `@Public()`.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // Autorización por rol. Necesita el `request.user` del anterior.
    // No hace nada salvo que el handler declare `@Roles(...)`.
    { provide: APP_GUARD, useClass: RolesGuard },
    // Estado de la suscripción del negocio. Va último porque es el más caro
    // (pega a la base) y no tiene sentido pagarlo si ya se rechazó por token o
    // por rol. No hace nada salvo que el handler declare
    // `@RequiresActiveSubscription()`.
    { provide: APP_GUARD, useClass: ActiveSubscriptionGuard },
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
