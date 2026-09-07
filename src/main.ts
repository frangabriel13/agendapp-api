// ⚠️ PRIMERO. Sentry instrumenta las librerías parchándolas al cargarlas, así
// que tiene que correr antes de que se importe nada de Nest. Ver `instrument.ts`.
import './instrument';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { shouldExposeDocs } from './common/security/security-headers';
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

  // En producción no se publica: la documentación interactiva es el mapa
  // completo de la API —cada ruta, cada campo, cada regla de validación— y eso
  // es trabajo de reconocimiento que no hay por qué regalar. La decisión vive
  // en `shouldExposeDocs` y no en un `if` acá para que tenga un test: el
  // bootstrap no lo ejecuta ninguno.
  if (shouldExposeDocs(config.get('NODE_ENV', { infer: true }))) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('AgendApp API')
      .setDescription('Backend del SaaS multi-tenant de gestión de turnos.')
      .setVersion('0.1.0')
      .addBearerAuth()
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup('api', app, document);
  }

  /**
   * Sin esto, un `SIGTERM` mata el proceso sin avisarle a nadie.
   *
   * Es lo que hace que `onModuleDestroy` corra al apagar, y de ahí cuelga algo
   * concreto: `PrismaService` cierra el pool de `pg` que él mismo creó (el de
   * `TenantPool`, que Prisma no conoce y por lo tanto no cierra). Sin hooks,
   * cada rollout deja conexiones colgadas hasta que Postgres las expira solo,
   * y con réplicas eso se acumula.
   *
   * En un contenedor pesa más que en local: el orquestador manda `SIGTERM`,
   * espera unos segundos y después manda `SIGKILL`. Todo lo que haya que
   * cerrar ordenadamente tiene que pasar en esa ventana.
   */
  app.enableShutdownHooks();

  const port = config.get('PORT', { infer: true });

  // El host explícito es para el contenedor: escuchando en la interfaz de
  // loopback, el proceso anda pero nadie lo alcanza desde afuera y el síntoma
  // es un healthcheck que falla sin un solo error en el log.
  await app.listen(port, '0.0.0.0');
}

void bootstrap();
