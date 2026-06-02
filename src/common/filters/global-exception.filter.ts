import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';

type ErrorResponseBody = {
  statusCode: number;
  message: string | string[];
  error?: string;
  timestamp: string;
  path: string;
};

const GENERIC_INTERNAL_ERROR =
  'Ocorreu um erro interno. Tente novamente mais tarde.';

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const request = ctx.getRequest<Request>();
    const response = ctx.getResponse<Response>();

    if (response.headersSent) {
      this.logger.error({
        statusCode: 500,
        method: request.method,
        path: request.url,
        errorName:
          exception instanceof Error ? exception.name : typeof exception,
        errorMessage: 'Exception after headers already sent — response not written',
      });
      return;
    }

    const body = this.buildResponseBody(exception, request);

    this.logException(exception, request, body.statusCode);

    response.status(body.statusCode).json(body);
  }

  private buildResponseBody(
    exception: unknown,
    request: Request,
  ): ErrorResponseBody {
    if (exception instanceof HttpException) {
      return this.fromHttpException(exception, request);
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.fromKnownPrismaError(exception, request);
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return this.generic(HttpStatus.BAD_REQUEST, 'Dados invalidos.', request);
    }

    // body-parser throws a plain Error (not HttpException) when the request
    // body exceeds the configured limit.  Map it to 413 so the client receives
    // the correct status instead of a misleading 500.
    if (this.isPayloadTooLarge(exception)) {
      return this.generic(
        HttpStatus.PAYLOAD_TOO_LARGE,
        'Payload muito grande.',
        request,
      );
    }

    return this.generic(
      HttpStatus.INTERNAL_SERVER_ERROR,
      GENERIC_INTERNAL_ERROR,
      request,
    );
  }

  private isPayloadTooLarge(exception: unknown): boolean {
    if (!(exception instanceof Error)) return false;
    const err = exception as Error & { type?: string };
    return (
      err.name === 'PayloadTooLargeError' ||
      err.type === 'entity.too.large'
    );
  }

  private fromHttpException(
    exception: HttpException,
    request: Request,
  ): ErrorResponseBody {
    const statusCode = exception.getStatus();
    const response = exception.getResponse();

    if (typeof response === 'string') {
      return this.generic(statusCode, response, request);
    }

    if (response && typeof response === 'object') {
      const responseBody = response as {
        message?: string | string[];
        error?: string;
      };

      return {
        statusCode,
        message: responseBody.message ?? exception.message,
        ...(responseBody.error ? { error: responseBody.error } : {}),
        timestamp: new Date().toISOString(),
        path: request.url,
      };
    }

    return this.generic(statusCode, exception.message, request);
  }

  private fromKnownPrismaError(
    exception: Prisma.PrismaClientKnownRequestError,
    request: Request,
  ): ErrorResponseBody {
    if (exception.code === 'P2002') {
      return this.generic(
        HttpStatus.CONFLICT,
        'Ja existe um registro com essas informacoes.',
        request,
      );
    }

    if (exception.code === 'P2025') {
      return this.generic(
        HttpStatus.NOT_FOUND,
        'Registro nao encontrado.',
        request,
      );
    }

    return this.generic(
      HttpStatus.INTERNAL_SERVER_ERROR,
      GENERIC_INTERNAL_ERROR,
      request,
    );
  }

  private generic(
    statusCode: number,
    message: string,
    request: Request,
  ): ErrorResponseBody {
    return {
      statusCode,
      message,
      timestamp: new Date().toISOString(),
      path: request.url,
    };
  }

  private logException(
    exception: unknown,
    request: Request,
    statusCode: number,
  ): void {
    if (statusCode === 401 || statusCode === 403) {
      return;
    }

    if (statusCode < 500) return;

    const errorName =
      exception instanceof Error ? exception.name : typeof exception;
    const errorMessage =
      exception instanceof Error ? redactSensitive(exception.message) : 'unknown';

    const prismaCode =
      exception instanceof Prisma.PrismaClientKnownRequestError
        ? (exception as Prisma.PrismaClientKnownRequestError).code
        : undefined;

    this.logger.error({
      statusCode,
      method: request.method,
      path: request.url,
      errorName,
      errorMessage,
      prismaCode,
    });
  }
}

function redactSensitive(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/refresh_token=([^;\s]+)/gi, 'refresh_token=[REDACTED]')
    .replace(/access[_-]?token["'=:\s]+[^,\s"}]+/gi, 'accessToken=[REDACTED]')
    .replace(/refresh[_-]?token["'=:\s]+[^,\s"}]+/gi, 'refreshToken=[REDACTED]')
    .replace(/password["'=:\s]+[^,\s"}]+/gi, 'password=[REDACTED]')
    .replace(/api[_-]?key["'=:\s]+[^,\s"}]+/gi, 'apiKey=[REDACTED]')
    .slice(0, 500);
}
