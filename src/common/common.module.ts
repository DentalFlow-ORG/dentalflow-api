import { Global, Module } from '@nestjs/common';
import { AccessPolicyService } from './services/access-policy.service';

@Global()
@Module({
  providers: [AccessPolicyService],
  exports: [AccessPolicyService],
})
export class CommonModule {}
