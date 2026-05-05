import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { appConfig } from './../src/config/app.config';

describe('App (e2e)', () => {
  let app: INestApplication<App>;
  const prefix = appConfig.apiPrefix;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix(prefix);
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it(`GET /${prefix}/health returns ok status`, () => {
    return request(app.getHttpServer())
      .get(`/${prefix}/health`)
      .expect(200)
      .expect((res) => {
        expect(res.body).toHaveProperty('status');
      });
  });

  it('POST /api/auth/login rejects missing credentials with 400', () => {
    return request(app.getHttpServer())
      .post(`/${prefix}/auth/login`)
      .send({})
      .expect(400);
  });

  it('GET /api/auth/me requires authentication', () => {
    return request(app.getHttpServer())
      .get(`/${prefix}/auth/me`)
      .expect(401);
  });

  it('GET /api/patients requires authentication', () => {
    return request(app.getHttpServer())
      .get(`/${prefix}/patients`)
      .expect(401);
  });
});
