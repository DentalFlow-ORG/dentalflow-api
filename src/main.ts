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
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { NEST_APP_OPTIONS, configureApp } from './bootstrap/configure-app';
import { appConfig } from './config/app.config';
import { validateEnv } from './config/validate-env';

async function bootstrap() {
  validateEnv();
  const app = await NestFactory.create(AppModule, NEST_APP_OPTIONS);

  configureApp(app);

  await app.listen(appConfig.port);
}
void bootstrap();
