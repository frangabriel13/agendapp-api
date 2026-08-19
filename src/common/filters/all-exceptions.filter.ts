import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';
import { isExclusionViolation } from '../../prisma/exclusion-violation';
import { TenantContextMissingError } from '../errors/tenant-context-missing.error';
import type { Request, Response } from 'express';

/** Claves que arma este filtro y que un service no puede pisar desde el cuerpo. */
const RESERVED_KEYS = new Set(['statusCode', 'message', 'error']);

interface ErrorResponseBody {
  statusCode: number;
  message: string | string[];
  error: string;
  path: string;
  timestamp: string;
  requestId?: string;

  /**
   * Datos extra que un service adjuntó al error para que el front pueda actuar
   * sobre él. Hoy lo usa el 409 de `POST /customers`, que manda la ficha ya
   * existente para poder ofrecer "¿es esta persona?" en vez de un cartel rojo.
   */
  [key: string]: unknown;
}

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const body = this.mapException(exception, request);

    if (body.statusCode >= 500) {
      this.logger.error(
        { err: exception, path: body.path, requestId: body.requestId },
        body.message,
      );
    } else {
      this.logger.warn(
        {
          path: body.path,
          requestId: body.requestId,
          statusCode: body.statusCode,
        },
        Array.isArray(body.message) ? body.message.join('; ') : body.message,
      );
    }

    response.status(body.statusCode).json(body);
  }

  private mapException(
    exception: unknown,
    request: Request,
  ): ErrorResponseBody {
    const reqWithId = request as Request & { id?: string | number };
    const headerId = request.headers['x-request-id'];
    const base = {
      path: request.url,
      timestamp: new Date().toISOString(),
      requestId:
        reqWithId.id !== undefined
          ? String(reqWithId.id)
          : typeof headerId === 'string'
            ? headerId
            : undefined,
    };

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : ((response as { message?: string | string[] }).message ??
            exception.message);
      return {
        ...base,
        ...extraFields(response),
        statusCode: status,
        message,
        error: HttpStatus[status] ?? 'Error',
      };
    }

    if (exception instanceof ZodError) {
      return {
        ...base,
        statusCode: HttpStatus.BAD_REQUEST,
        message: exception.issues.map(
          (i) => `${i.path.join('.') || '(root)'}: ${i.message}`,
        ),
        error: 'Bad Request',
      };
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.mapPrismaKnownError(exception, base);
    }

    /**
     * Red de seguridad para el doble-booking (Fase 5).
     *
     * Prisma **no traduce** las violaciones de EXCLUDE constraint: llegan como
     * un error crudo del driver, no como `PrismaClientKnownRequestError`. Los
     * services de turnos las capturan y las convierten en un 409 con un mensaje
     * que dice qué se pisó; esto es para el caso de que alguna ruta se escape,
     * que salga 409 y no un 500.
     */
    if (isExclusionViolation(exception)) {
      return {
        ...base,
        statusCode: HttpStatus.CONFLICT,
        message: 'Conflicto de horario: ese lugar ya está ocupado',
        error: 'Conflict',
      };
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        ...base,
        statusCode: HttpStatus.BAD_REQUEST,
        message: 'Invalid data for database operation',
        error: 'Bad Request',
      };
    }

    if (exception instanceof TenantContextMissingError) {
      // Es un bug del servidor, no del cliente.
      return {
        ...base,
        statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
        message: exception.message,
        error: 'Tenant Context Missing',
      };
    }

    return {
      ...base,
      statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
      message:
        exception instanceof Error
          ? exception.message
          : 'Internal server error',
      error: 'Internal Server Error',
    };
  }

  private mapPrismaKnownError(
    err: Prisma.PrismaClientKnownRequestError,
    base: Pick<ErrorResponseBody, 'path' | 'timestamp' | 'requestId'>,
  ): ErrorResponseBody {
    switch (err.code) {
      case 'P2002':
        return {
          ...base,
          statusCode: HttpStatus.CONFLICT,
          message: `Unique constraint violation on ${(err.meta?.target as string[] | undefined)?.join(', ') ?? 'record'}`,
          error: 'Conflict',
        };
      case 'P2025':
        return {
          ...base,
          statusCode: HttpStatus.NOT_FOUND,
          message:
            (err.meta?.cause as string | undefined) ?? 'Record not found',
          error: 'Not Found',
        };
      case 'P2003':
        return {
          ...base,
          statusCode: HttpStatus.BAD_REQUEST,
          message: `Foreign key constraint violation on ${(err.meta?.field_name as string | undefined) ?? 'relation'}`,
          error: 'Bad Request',
        };
      default:
        return {
          ...base,
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: `Database error (${err.code})`,
          error: 'Internal Server Error',
        };
    }
  }
}

/**
 * Lo que un service puso en el cuerpo del error además del mensaje.
 *
 * Un `throw new ConflictException({ message, existingCustomer })` trae ese
 * `existingCustomer`; sin esto se perdería, porque el filtro arma la respuesta
 * desde cero y solo miraba `message`.
 *
 * Las claves que arma el propio filtro se descartan: se recalculan igual
 * después del spread, y dejarlas pasar significaría que un service puede mentir
 * sobre el status del error que él mismo lanzó.
 */
function extraFields(response: string | object): Record<string, unknown> {
  if (typeof response !== 'object') {
    return {};
  }

  return Object.fromEntries(
    Object.entries(response).filter(([key]) => !RESERVED_KEYS.has(key)),
  );
}
