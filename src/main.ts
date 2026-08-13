import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import type { Env } from './config/env.schema';
import { RATE_LIMIT_HEADERS } from './config/throttler.config';

/**
 * El `ValidationPipe` y el `AllExceptionsFilter` NO se registran acá sino como
 * providers (`APP_PIPE` / `APP_FILTER`) en `AppModule`: así los tests e2e, que
 * levantan la app con `createNestApplication()` sin pasar por este bootstrap,
 * corren con exactamente el mismo comportamiento que producción.
 */
async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { bufferLogs: true });

  app.useLogger(app.get(Logger));

  const config = app.get(ConfigService<Env, true>);

  /**
   * Sin esto, el navegador bloquea cualquier llamada del frontend: una página
   * servida desde otro origen no puede leer la respuesta de esta API.
   *
   * `credentials` habilita mandar cookies; hoy la sesión va por header
   * `Authorization`, pero queda listo si algún día el refresh token pasa a una
   * cookie httpOnly. Por eso también la lista de orígenes es explícita y no
   * `*`: con credenciales, el comodín no está permitido.
   *
   * `exposedHeaders` es el detalle que se olvida siempre: por defecto el JS del
   * cliente solo ve un puñado de headers estándar. Sin declararlos acá, los del
   * rate limit existen en la respuesta pero el frontend no los puede leer.
   */
  app.enableCors({
    origin: config.get('CORS_ORIGINS', { infer: true }),
    credentials: true,
    exposedHeaders: RATE_LIMIT_HEADERS,
  });

  const swaggerConfig = new DocumentBuilder()
    .setTitle('AgendApp API')
    .setDescription('Backend del SaaS multi-tenant de gestión de turnos.')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('api', app, document);

  const port = config.get('PORT', { infer: true });
  await app.listen(port);
}

void bootstrap();
