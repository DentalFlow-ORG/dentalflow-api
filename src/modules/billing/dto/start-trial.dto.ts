import { IsIn, IsNotEmpty, IsString } from 'class-validator';

export type BillingIntervalValue = 'MONTHLY' | 'YEARLY';

export class StartTrialDto {
  @IsString()
  @IsNotEmpty({ message: 'planKey é obrigatório' })
  planKey!: string;

  @IsIn(['MONTHLY', 'YEARLY'], {
    message: 'billingInterval deve ser MONTHLY ou YEARLY',
  })
  billingInterval!: BillingIntervalValue;
}
