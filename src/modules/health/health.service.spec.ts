import { HealthService } from './health.service';

describe('HealthService', () => {
  it('should return the current application status', async () => {
    const service = new HealthService({
      $queryRaw: jest.fn().mockResolvedValue([{ '?column?': 1 }]),
    } as never);

    await expect(service.getStatus()).resolves.toMatchObject({
      name: 'DentalFlow API',
      status: 'ok',
      db: 'connected',
    });
  });
});
