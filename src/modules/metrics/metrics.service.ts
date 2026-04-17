import { Injectable } from '@nestjs/common';

@Injectable()
export class MetricsService {
  getTemplate() {
    return {
      module: 'metrics',
      ready: true,
    };
  }
}
