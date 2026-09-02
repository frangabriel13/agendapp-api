import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { catchError, concatMap, from, throwError, type Observable } from 'rxjs';
import { TenantContextService } from '../tenant-context';
import { AUDIT_KEY } from './audit.decorator';
import { AuditService } from './audit.service';
import type { AuditOptions } from './audit.types';
import { toAuditChanges } from './redact';

/** Tope del `User-Agent` que se guarda; la columna admite 255. */
const MAX_USER_AGENT = 255;

/**
 * Registra los handlers marcados con `@Audited(...)`.
 *
 * Tres cosas que no son obvias:
 *
 * 1. **No hay diff contra el estado anterior, y no es una simplificación
 *    temporal.** Un interceptor corre alrededor del handler: cuando podría
 *    leer el "antes", todavía no sabe qué se va a tocar, y cuando sabe, ya
 *    está tocado. Lo que sí puede registrar —y alcanza para la pregunta que la
 *    auditoría contesta— es *quién*, *qué acción*, *sobre qué*, *con qué datos*
 *    y *desde dónde*. El día que haga falta un diff de verdad, va en el service
 *    que sí tiene las dos fotos.
 * 2. **Se espera al INSERT antes de responder**, y eso es a propósito. La
 *    tentación es soltarlo (`void this.audit.record(...)`) para no hacerle
 *    pagar a nadie el costo de nuestra contabilidad; el problema es que un
 *    registro que puede estar o no estar cuando lo mirás no es un registro. Son
 *    nueve endpoints de baja frecuencia y un INSERT en el mismo pool: la
 *    latencia que suma no se mide, y a cambio la fila está siempre. Si algún
 *    día hay un número que diga lo contrario, lo que corresponde es una cola —
 *    no soltar la promesa y esperar que llegue.
 * 3. **El request se fotografía ANTES** (`snapshot`): body, IP y user-agent se
 *    leen mientras el request es el request. El contexto de tenant, en cambio,
 *    se relee al escribir, porque hay un handler que lo resuelve adentro:
 *    `/auth/login` no tiene identidad hasta que la contraseña verifica.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly audit: AuditService,
    private readonly tenantContext: TenantContextService,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const options = this.reflector.getAllAndOverride<AuditOptions>(AUDIT_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!options) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<Request>();
    const base = this.snapshot(request, options);

    return next.handle().pipe(
      concatMap(async (response: unknown) => {
        await this.audit.record({
          // El contexto se relee acá y no se usa el de `snapshot`: hay un
          // handler —`/auth/login`— que resuelve la identidad recién adentro,
          // porque antes de validar la contraseña no había ninguna. Para todos
          // los demás las dos lecturas dan lo mismo.
          ...base,
          tenantId: this.tenantContext.getTenantId() ?? base.tenantId,
          userId: this.tenantContext.getUserId() ?? base.userId,
          entityId: base.entityId ?? idOf(response, options.entityIdFrom),
        });

        return response;
      }),
      catchError((error: unknown) => {
        if (!options.alsoOnFailure) {
          return throwError(() => error);
        }

        return from(
          this.audit.record({ ...base, action: `${options.action}_failed` }),
        ).pipe(concatMap(() => throwError(() => error)));
      }),
    );
  }

  /**
   * Todo lo que hace falta del request, leído ya mismo.
   *
   * `JwtAuthGuard` ya corrió (los guards van antes que los interceptors), así
   * que acá el contexto está resuelto — salvo en una ruta `@Public()`, que es
   * justamente el caso del login: ahí `tenantId` y `userId` quedan en `null`, y
   * por eso las dos columnas son nullables.
   */
  private snapshot(request: Request, options: AuditOptions) {
    const params = request.params as Record<string, string | undefined>;
    const fromRoute = params[options.entityIdParam ?? 'id'];

    return {
      tenantId: this.tenantContext.getTenantId(),
      userId: this.tenantContext.getUserId(),
      action: options.action as string,
      entityType: options.entityType as string,
      entityId: fromRoute ?? null,
      changes: toAuditChanges(request.body),
      ipAddress: request.ip ?? null,
      userAgent: request.get('user-agent')?.slice(0, MAX_USER_AGENT) ?? null,
    };
  }
}

/**
 * El id sacado de la respuesta, para el alta: antes de escribir no existía.
 *
 * `path` es un camino con puntos porque no todas las altas devuelven la entidad
 * pelada. Si el camino no llega a un string, devuelve `null` en vez de romper:
 * una fila de auditoría sin `entityId` sigue sirviendo, una excepción acá
 * voltearía un alta que ya se escribió.
 */
function idOf(response: unknown, path = 'id'): string | null {
  let current: unknown = response;

  for (const step of path.split('.')) {
    if (current === null || typeof current !== 'object') {
      return null;
    }

    current = (current as Record<string, unknown>)[step];
  }

  return typeof current === 'string' ? current : null;
}
