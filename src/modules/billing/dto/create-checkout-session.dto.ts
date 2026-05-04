import { IsIn, IsNotEmpty, IsString } from 'class-validator';

export type BillingIntervalValue = 'MONTHLY' | 'YEARLY';

export class CreateCheckoutSessionDto {
  @IsString()
  @IsNotEmpty({ message: 'planId é obrigatório' })
  planId!: string;

  @IsIn(['MONTHLY', 'YEARLY'], {
    message: 'billingInterval deve ser MONTHLY ou YEARLY',
  })
  billingInterval!: BillingIntervalValue;
}
