import { randomUUID } from 'node:crypto';
import {
  INestApplication,
  RequestMethod,
  ValidationPipe,
} from '@nestjs/common';
import type { NestApplicationOptions } from '@nestjs/common';
import helmet from 'helmet';
import * as express from 'express';
import { appConfig } from '../config/app.config';

/**
 * Everything `main.ts` does to a freshly created Nest application.
 *
 * It lives here rather than inline in `bootstrap()` so a test can boot the
 * application the way production does. Security headers, the CORS policy, the
 * body-size limits and the route prefix are all behaviour, and behaviour that
 * only exists inside `main.ts` is behaviour nothing can assert on.
 */

/**
 * Options `NestFactory.create` (or `createNestApplication`) must be given for
 * `configureApp` to make sense: Nest's own body parsers are off because we
 * register our own with a higher limit and Stripe's raw-body capture.
 */
export const NEST_APP_OPTIONS: NestApplicationOptions = {
  rawBody: true,
  bodyParser: false,
};

// ── Route helper ──────────────────────────────────────────────────────────────
// Identifies the clinical dictation endpoint so it can be routed to the 6 MB
// JSON parser instead of the global 100 kb parser.
//
// WHY NOT app.use(regex, fn)?
// Express treats the portion matched by the regex as a URL prefix to strip.
// When the regex matches a substring (i.e. /clinical-records/…/dictate starting
// at position 4 after /api), Express's path-separator validation check fires:
//   path[matched_length] is not '/' or undefined  → next() is called without
//   invoking the middleware, silently skipping the 6 MB parser.
// Using an explicit middleware wrapper completely bypasses this issue.
//
// Two patterns are tested so the helper works with and without the API prefix
// (e.g. direct access, reverse-proxy, or a different API_PREFIX env value).
export function isClinicalDictationRoute(req: express.Request): boolean {
  const path = req.path || (req.url ?? '').split('?')[0];
  return (
    /^\/api\/clinical-records\/[^/]+\/dictate$/.test(path) ||
    /^\/clinical-records\/[^/]+\/dictate$/.test(path)
  );
}

export function configureApp(app: INestApplication): void {
  // CORS must be the very first middleware so that every response — including
  // error responses thrown by the body parsers below (413 / 400) — carries the
  // Access-Control-Allow-Origin header.  Without this ordering the browser
  // cannot read the real HTTP status from the cross-origin error response and
  // reports a generic "No Access-Control-Allow-Origin" CORS failure instead.
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      if (!origin) {
        // No Origin header: server-to-server or health check request — allow.
        callback(null, true);
        return;
      }

      if (appConfig.frontendOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      // Deny without throwing: a rejected origin simply receives no
      // Access-Control-Allow-Origin header (the browser blocks it), instead of
      // an unhandled callback error surfacing as a 500.
      callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['X-Request-ID'],
    maxAge: 600,
  });

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      frameguard: { action: 'deny' },
      hidePoweredBy: true,
      hsts:
        appConfig.nodeEnv === 'production'
          ? { maxAge: 15552000, includeSubDomains: true }
          : false,
      noSniff: true,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  // ── No-store ─────────────────────────────────────────────────────────────────
  // Every API response is authenticated JSON or a public catalogue; none of it
  // belongs in a browser disk cache or a shared/proxy cache where another user
  // of the machine could read it. `no-store` is the conservative default for an
  // API and costs nothing here (no cacheable assets are served from this app).
  app.use(
    (
      req: express.Request & { requestId?: string },
      res: express.Response,
      next: express.NextFunction,
    ) => {
      req.requestId = randomUUID();
      res.setHeader('X-Request-ID', req.requestId);
      res.setHeader('Cache-Control', 'no-store');
      next();
    },
  );

  // ── Body parsers ─────────────────────────────────────────────────────────────
  // Registered as explicit wrapper middleware rather than app.use(regex, fn)
  // to avoid Express's silent middleware-skip bug (see isClinicalDictationRoute).

  // 1. Clinical dictation — 6 MB.
  //    Headroom: DTO MaxLength 4 000 000 chars ≈ 3.81 MB; parser limit 6 MB
  //    gives ~57 % headroom so DTO validation returns 400 before body-parser 413.
  app.use(
    (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (!isClinicalDictationRoute(req)) {
        return next();
      }
      // Dev-only routing confirmation — safe: logs method + path only, no body.
      if (appConfig.nodeEnv !== 'production') {
        console.log(
          `[ClinicalDictation] ${req.method} ${req.path} — using 6 MB JSON parser`,
        );
      }
      return express.json({ limit: '6mb' })(req, res, next);
    },
  );

  // 2. Global 100 kb limit — all non-dictation routes.
  //    Explicitly skips dictation so body-parser does not attempt to re-parse
  //    an already-consumed stream (belt-and-suspenders over req._body).
  //    rawBody verify captures the raw buffer needed by the Stripe webhook.
  app.use(
    (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (isClinicalDictationRoute(req)) {
        return next();
      }
      return express.json({
        limit: '100kb',
        verify: (
          rawReq: express.Request & { rawBody?: Buffer },
          _res: express.Response,
          buf: Buffer,
        ) => {
          if (Buffer.isBuffer(buf)) rawReq.rawBody = buf;
        },
      })(req, res, next);
    },
  );

  app.use(express.urlencoded({ extended: true, limit: '100kb' }));

  if (appConfig.nodeEnv === 'production') {
    const httpInstance = app.getHttpAdapter().getInstance() as express.Express;
    httpInstance.set('trust proxy', 1);
  }

  app.setGlobalPrefix(appConfig.apiPrefix, {
    exclude: [{ path: 'webhooks/whatsapp', method: RequestMethod.ALL }],
  });
  app.enableShutdownHooks();
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
}
