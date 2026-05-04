import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { BillingInterval } from '@prisma/client';
import { stripeConfig } from '../../config/stripe.config';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';
import { StripeService } from './stripe.service';

@Injectable()
export class BillingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
  ) {}

  async createCheckoutSession(
    clinicId: string,
    userId: string,
    dto: CreateCheckoutSessionDto,
  ): Promise<{ url: string }> {
    // 1. Validate plan exists and is active
    const plan = await this.prisma.plan.findUnique({
      where: { id: dto.planId },
    });

    if (!plan || !plan.isActive) {
      throw new NotFoundException('Plano não encontrado ou inativo.');
    }

    // 2. Resolve the Stripe price ID for the chosen billing interval
    const priceId =
      dto.billingInterval === BillingInterval.MONTHLY
        ? plan.stripePriceIdMonthly
        : plan.stripePriceIdYearly;

    if (!priceId) {
      const intervalLabel =
        dto.billingInterval === BillingInterval.MONTHLY ? 'mensal' : 'anual';
      throw new BadRequestException(
        `Este plano não possui um preço ${intervalLabel} configurado. Entre em contato com o suporte.`,
      );
    }

    // 3. Load the clinic's existing subscription and clinic profile in parallel
    const [existingSubscription, clinic] = await Promise.all([
      this.prisma.subscription.findUnique({ where: { clinicId } }),
      this.prisma.clinic.findUniqueOrThrow({
        where: { id: clinicId },
        select: { name: true, email: true },
      }),
    ]);

    // 4. Resolve or create the Stripe Customer for this clinic.
    //    Reuse the stored customer ID to prevent duplicate Stripe customers
    //    across multiple checkout attempts from the same clinic.
    let stripeCustomerId: string;

    if (existingSubscription?.stripeCustomerId) {
      stripeCustomerId = existingSubscription.stripeCustomerId;
    } else {
      const customer = await this.stripe.getClient().customers.create({
        name: clinic.name,
        email: clinic.email ?? undefined,
        metadata: { clinicId },
      });
      stripeCustomerId = customer.id;
    }

    // 5. Upsert the local Subscription record so the Stripe customer ID is
    //    persisted before the session is created. Status stays TRIALING and
    //    stripeSubscriptionId stays null — the webhook is responsible for
    //    updating both once Stripe confirms the completed checkout.
    await this.prisma.subscription.upsert({
      where: { clinicId },
      create: {
        clinicId,
        planId: dto.planId,
        stripeCustomerId,
        billingInterval: dto.billingInterval,
        status: 'TRIALING',
      },
      update: {
        planId: dto.planId,
        stripeCustomerId,
        billingInterval: dto.billingInterval,
        // status is intentionally NOT updated here — only the webhook may
        // transition an already-active subscription.
      },
    });

    // 6. Create the Stripe Checkout Session
    const session = await this.stripe.getClient().checkout.sessions.create({
      mode: 'subscription',
      customer: stripeCustomerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: stripeConfig.successUrl,
      cancel_url: stripeConfig.cancelUrl,
      metadata: {
        clinicId,
        planId: dto.planId,
        billingInterval: dto.billingInterval,
        userId,
      },
    });

    if (!session.url) {
      throw new InternalServerErrorException(
        'Não foi possível gerar o link de pagamento. Tente novamente.',
      );
    }

    return { url: session.url };
  }

  getTemplate() {
    return {
      module: 'billing',
      ready: true,
      stripeConfigured: Boolean(stripeConfig.secretKey),
    };
  }
}
