import './config/load-env';
// Suppress pg@8 deprecation for concurrent client.query() — upstream issue in @prisma/adapter-pg
// https://github.com/prisma/prisma/issues — remove once adapter is fixed
process.on('warning', (warning) => {
  if (
    warning.name === 'DeprecationWarning' &&
    warning.message.includes('client.query()')
  ) {
    return;
  }
  console.warn(warning);
});
import { RequestMethod, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import * as express from 'express';
import { AppModule } from './app.module';
import { appConfig } from './config/app.config';
import { validateEnv } from './config/validate-env';

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
function isClinicalDictationRoute(req: express.Request): boolean {
  const path = req.path || (req.url ?? '').split('?')[0];
  return (
    /^\/api\/clinical-records\/[^/]+\/dictate$/.test(path) ||
    /^\/clinical-records\/[^/]+\/dictate$/.test(path)
  );
}

async function bootstrap() {
  validateEnv();
  // bodyParser:false — we register our own with higher limit + rawBody support for Stripe
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    bodyParser: false,
  });

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

      callback(new Error('Origem nao permitida pelo CORS.'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
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

  await app.listen(appConfig.port);
}
void bootstrap();
