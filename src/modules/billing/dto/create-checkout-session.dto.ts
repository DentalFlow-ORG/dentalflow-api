import { IsEnum, IsNotEmpty, IsString } from 'class-validator';
import { BillingInterval } from '@prisma/client';

export class CreateCheckoutSessionDto {
  @IsString()
  @IsNotEmpty({ message: 'planId é obrigatório' })
  planId!: string;

  @IsEnum(BillingInterval, { message: 'billingInterval deve ser MONTHLY ou YEARLY' })
  billingInterval!: BillingInterval;
}