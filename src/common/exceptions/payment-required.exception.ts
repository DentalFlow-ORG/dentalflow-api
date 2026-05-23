import { HttpException, HttpStatus } from '@nestjs/common';

type PaymentRequiredDetails = {
  status?: string;
  requiresPlanSelection?: boolean;
  requiresPayment?: boolean;
};

export class PaymentRequiredException extends HttpException {
  constructor(message: string, details: PaymentRequiredDetails = {}) {
    super(
      {
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        error: 'Payment Required',
        message,
        accessAllowed: false,
        ...details,
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}
