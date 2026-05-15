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
import { TenantContextMissingError } from '../errors/tenant-context-missing.error';
import type { Request, Response } from 'express';

interface ErrorResponseBody {
  statusCode: number;
  message: string | string[];
  error: string;
  path: string;
  timestamp: string;
  requestId?: string;
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
        // Postgres exclusion constraint (Fase 5: doble-booking de turnos).
        if ((err.meta?.code as string | undefined) === '23P01') {
          return {
            ...base,
            statusCode: HttpStatus.CONFLICT,
            message: 'Conflicto de horario: el slot ya está ocupado',
            error: 'Conflict',
          };
        }
        return {
          ...base,
          statusCode: HttpStatus.INTERNAL_SERVER_ERROR,
          message: `Database error (${err.code})`,
          error: 'Internal Server Error',
        };
    }
  }
}
