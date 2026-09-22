import { ServiceUnavailableException } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';

/**
 * The health endpoint is what uptime monitoring and the platform load balancer
 * read. It previously answered 200 / "ok" even when the database was down,
 * which would have kept an unusable API in rotation and shown a green monitor
 * during a total outage.
 */

function healthyService() {
  return new HealthService({
    $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
  } as never);
}

function brokenService() {
  return new HealthService({
    $queryRaw: jest.fn().mockRejectedValue(new Error('connection refused')),
  } as never);
}

describe('HealthService', () => {
  it('reports ok and a connected database when the query succeeds', async () => {
    await expect(healthyService().getStatus()).resolves.toMatchObject({
      name: 'DentalFlow API',
      status: 'ok',
      db: 'connected',
    });
  });

  it('reports unavailable when the database query throws', async () => {
    await expect(brokenService().getStatus()).resolves.toMatchObject({
      status: 'unavailable',
      db: 'error',
    });
  });

  it('never propagates the database error to the caller', async () => {
    // The probe must answer rather than 500, so the body can say what failed.
    await expect(brokenService().getStatus()).resolves.toBeDefined();
  });
});

describe('HealthController', () => {
  it('answers 200 with the status body when the database is reachable', async () => {
    const controller = new HealthController(healthyService());

    await expect(controller.getStatus()).resolves.toMatchObject({
      status: 'ok',
      db: 'connected',
    });
  });

  it('answers 503 when the database is unreachable', async () => {
    const controller = new HealthController(brokenService());

    await expect(controller.getStatus()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('keeps the diagnostic body on the 503 response', async () => {
    // Operators need to see which dependency failed, not a bare 503.
    const controller = new HealthController(brokenService());

    await controller.getStatus().catch((err: ServiceUnavailableException) => {
      expect(err.getStatus()).toBe(503);
      expect(err.getResponse()).toMatchObject({
        status: 'unavailable',
        db: 'error',
      });
    });

    expect.assertions(2);
  });
});
