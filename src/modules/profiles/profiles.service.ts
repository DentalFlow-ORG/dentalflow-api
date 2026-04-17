import { Injectable } from '@nestjs/common';

@Injectable()
export class ProfilesService {
  getTemplate() {
    return {
      module: 'profiles',
      ready: true,
    };
  }
}
