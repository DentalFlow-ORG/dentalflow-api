import { Injectable } from '@nestjs/common';
import { APP_NAME } from '../../common/constants/app.constants';
import { appConfig } from '../../config/app.config';

@Injectable()
export class HealthService {
  getStatus() {
    return {
      name: APP_NAME,
      status: 'ok',
      environment: appConfig.nodeEnv,
      timestamp: new Date().toISOString(),
    };
  }
}
