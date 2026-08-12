import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { Env } from './config/env.schema';

/**
 * El `ValidationPipe` y el `AllExceptionsFilter` NO se registran acá sino como
 * providers (`APP_PIPE` / `APP_FILTER`) en `AppModule`: así los tests e2e, que
 * levantan la app con `createNestApplication()` sin pasar por este bootstrap,
 * corren con exactamente el mismo comportamiento que producción.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));

  const swaggerConfig = new DocumentBuilder()
    .setTitle('AgendApp API')
    .setDescription('Backend del SaaS multi-tenant de gestión de turnos.')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api', app, document);

  const config = app.get(ConfigService<Env, true>);
  const port = config.get('PORT', { infer: true });
  await app.listen(port);
}

void bootstrap();
