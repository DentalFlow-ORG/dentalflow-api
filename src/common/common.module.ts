import { Global, Module } from '@nestjs/common';
import { AccessPolicyService } from './services/access-policy.service';
import { PatientIdentityService } from './services/patient-identity.service';
import { PatientResolverService } from './services/patient-resolver.service';

@Global()
@Module({
  providers: [
    AccessPolicyService,
    PatientIdentityService,
    PatientResolverService,
  ],
  exports: [
    AccessPolicyService,
    PatientIdentityService,
    PatientResolverService,
  ],
})
export class CommonModule {}
