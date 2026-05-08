import { IsIn, IsOptional, IsString } from 'class-validator';

export type BillingIntervalValue = 'MONTHLY' | 'YEARLY';

export class CreateCheckoutSessionDto {
  @IsString()
  @IsOptional()
  planId?: string;

  @IsString()
  @IsOptional()
  planKey?: string;

  @IsIn(['MONTHLY', 'YEARLY'], {
    message: 'billingInterval deve ser MONTHLY ou YEARLY',
  })
  billingInterval!: BillingIntervalValue;
}
