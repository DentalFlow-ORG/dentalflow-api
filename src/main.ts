import './config/load-env';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { appConfig } from './config/app.config';
import { validateEnv } from './config/validate-env';

async function bootstrap() {
  validateEnv();
  const app = await NestFactory.create(AppModule, { rawBody: true });
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
