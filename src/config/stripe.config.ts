type StripeConfig = {
  secretKey: string;
  webhookSecret: string;
  successUrl: string;
  cancelUrl: string;
  portalReturnUrl: string;
};

export const stripeConfig: StripeConfig = {
  secretKey: process.env.STRIPE_SECRET_KEY ?? '',
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
  successUrl:
    process.env.STRIPE_SUCCESS_URL ??
    'http://localhost:5173/app/assinatura/sucesso',
  cancelUrl:
    process.env.STRIPE_CANCEL_URL ??
    'http://localhost:5173/app/assinatura/cancelar',
  portalReturnUrl:
    process.env.STRIPE_PORTAL_RETURN_URL ??
    'http://localhost:5173/app/assinatura',
};
