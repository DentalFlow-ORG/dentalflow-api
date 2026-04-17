import { HealthService } from './health.service';

describe('HealthService', () => {
  it('should return the current application status', () => {
    const service = new HealthService();

    expect(service.getStatus()).toMatchObject({
      name: 'DentalFlow API',
      status: 'ok',
    });
  });
});
