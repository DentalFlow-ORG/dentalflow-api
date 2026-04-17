import { Injectable } from '@nestjs/common';

@Injectable()
export class UsersService {
  getTemplate() {
    return {
      module: 'users',
      ready: true,
    };
  }
}
