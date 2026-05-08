import { IsIn, IsString } from 'class-validator';
import { BillingIntervalValue } from './create-checkout-session.dto';

export class ChangeSubscriptionPlanDto {
  @IsString({ message: 'planKey é obrigatório' })
  planKey!: string;

  @IsIn(['MONTHLY', 'YEARLY'], {
    message: 'billingInterval deve ser MONTHLY ou YEARLY',
  })
  billingInterval!: BillingIntervalValue;
}
