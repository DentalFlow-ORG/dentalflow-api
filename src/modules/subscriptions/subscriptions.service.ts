import { Injectable } from '@nestjs/common';

@Injectable()
export class SubscriptionsService {
  getTemplate() {
    return {
      module: 'subscriptions',
      ready: true,
    };
  }
}
