import './config/load-env';
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
  app.use(
    express.json({
      limit: '10mb',
      verify: (
        req: express.Request & { rawBody?: Buffer },
        _res: express.Response,
        buf: Buffer,
      ) => {
        if (Buffer.isBuffer(buf)) req.rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));
  app.use(helmet());
  app.enableCors({
    origin: appConfig.frontendOrigin,
    credentials: true,
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
