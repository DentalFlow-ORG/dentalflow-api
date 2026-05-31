import 'reflect-metadata';
import { ArgumentsHost, BadRequestException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';

import { GlobalExceptionFilter } from './global-exception.filter';

// ── Host factory ──────────────────────────────────────────────────────────────

function buildHost(url = '/api/test') {
  const jsonFn = jest.fn();
  const statusFn = jest.fn().mockReturnValue({ json: jsonFn });
  const request = { url, method: 'POST' } as unknown as Request;
  const response = { status: statusFn } as unknown as Response;

  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ArgumentsHost;

  return { host, statusFn, jsonFn };
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('GlobalExceptionFilter', () => {
  let filter: GlobalExceptionFilter;

  beforeEach(() => {
    filter = new GlobalExceptionFilter();
    jest.clearAllMocks();
  });

  // ── NestJS HttpException passthrough ─────────────────────────────────────

  it('returns the correct HTTP status for a NestJS HttpException', () => {
    const { host, statusFn, jsonFn } = buildHost();
    filter.catch(new BadRequestException('campos inválidos'), host);

    expect(statusFn).toHaveBeenCalledWith(400);
    const body = jsonFn.mock.calls[0][0] as { statusCode: number; message: unknown };
    expect(body.statusCode).toBe(400);
  });

  // ── PayloadTooLargeError (body-parser name) → 413 ────────────────────────

  it('returns 413 for a PayloadTooLargeError thrown by body-parser', () => {
    const err = Object.assign(new Error('request entity too large'), {
      name: 'PayloadTooLargeError',
    });
    const { host, statusFn, jsonFn } = buildHost();
    filter.catch(err, host);

    expect(statusFn).toHaveBeenCalledWith(HttpStatus.PAYLOAD_TOO_LARGE);
    const body = jsonFn.mock.calls[0][0] as { statusCode: number; message: string };
    expect(body.statusCode).toBe(413);
    expect(body.message).toBe('Payload muito grande.');
    // Must not leak raw body-parser message or request details
    expect(JSON.stringify(body)).not.toContain('entity');
    expect(JSON.stringify(body)).not.toContain('too large');
  });

  // ── entity.too.large type → 413 ──────────────────────────────────────────

  it('returns 413 for an error with type "entity.too.large"', () => {
    const err = Object.assign(new Error('request entity too large'), {
      type: 'entity.too.large',
    });
    const { host, statusFn, jsonFn } = buildHost();
    filter.catch(err, host);

    expect(statusFn).toHaveBeenCalledWith(HttpStatus.PAYLOAD_TOO_LARGE);
    const body = jsonFn.mock.calls[0][0] as { statusCode: number };
    expect(body.statusCode).toBe(413);
  });

  // ── Generic unknown error → 500 ───────────────────────────────────────────

  it('returns 500 for a plain unknown Error', () => {
    const { host, statusFn } = buildHost();
    filter.catch(new Error('unexpected'), host);

    expect(statusFn).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
  });

  // ── 413 is NOT logged (client error) ────────────────────────────────────

  it('does not log PayloadTooLargeError because 413 < 500', () => {
    const err = Object.assign(new Error('request entity too large'), {
      name: 'PayloadTooLargeError',
    });
    const logSpy = jest.spyOn(
      (filter as unknown as { logger: { error: jest.Mock } }).logger,
      'error',
    );
    const { host } = buildHost();
    filter.catch(err, host);

    expect(logSpy).not.toHaveBeenCalled();
  });
});
