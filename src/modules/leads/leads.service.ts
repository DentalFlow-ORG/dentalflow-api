import { Injectable } from '@nestjs/common';

@Injectable()
export class LeadsService {
  getTemplate() {
    return {
      module: 'leads',
      ready: true,
    };
  }
}
