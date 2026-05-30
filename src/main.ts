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
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import * as express from 'express';
import { AppModule } from './app.module';
import { appConfig } from './config/app.config';
import { validateEnv } from './config/validate-env';

async function bootstrap() {
  validateEnv();
  // bodyParser:false — we register our own with higher limit + rawBody support for Stripe
  const app = await NestFactory.create(AppModule, {
    rawBody: true,
    bodyParser: false,
  });
  // Route-specific 2 MB limit for audio base64 dictation requests.
  // Registered BEFORE the global 100 kb parser so it parses the body first;
  // once parsed (req.body set), the global parser skips re-processing.
  // The regex matches /clinical-records/<id>/dictate regardless of API prefix.
  app.use(
    /\/clinical-records\/[^/]+\/dictate$/,
    express.json({ limit: '2mb' }),
  );

  // Global JSON body limit — all other routes.
  // rawBody verify is needed by the Stripe webhook controller.
  app.use(
    express.json({
      limit: '100kb',
      verify: (
        req: express.Request & { rawBody?: Buffer },
        _res: express.Response,
        buf: Buffer,
      ) => {
        if (Buffer.isBuffer(buf)) req.rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: true, limit: '100kb' }));

  if (appConfig.nodeEnv === 'production') {
    app.getHttpAdapter().getInstance().set('trust proxy', 1);
  }

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
  app.enableCors({
    origin: (origin, callback) => {
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
  app.setGlobalPrefix(appConfig.apiPrefix);
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
