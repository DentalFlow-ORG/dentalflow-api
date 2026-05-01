import { SetMetadata } from '@nestjs/common';

export const IS_ANY_AUTHENTICATED_KEY = 'isAnyAuthenticated';
export const AnyAuthenticated = () =>
  SetMetadata(IS_ANY_AUTHENTICATED_KEY, true);
