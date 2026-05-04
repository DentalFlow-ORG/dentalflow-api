import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';
import { StripeService } from './stripe.service';

type BillingIntervalValue = 'MONTHLY' | 'YEARLY';
type CancellableSubscriptionStatus = 'ACTIVE' | 'TRIALING' | 'PAST_DUE';

const CANCELLABLE_SUBSCRIPTION_STATUSES: CancellableSubscriptionStatus[] = [
  'ACTIVE',
  'TRIALING',
  'PAST_DUE',
];
const STRIPE_SUCCESS_URL: string =
  process.env.STRIPE_SUCCESS_URL ??
  'http://localhost:5173/app/assinatura/sucesso';
const STRIPE_CANCEL_URL: string =
  process.env.STRIPE_CANCEL_URL ??
  'http://localhost:5173/app/assinatura/cancelar';
const STRIPE_PORTAL_RETURN_URL: string =
  process.env.STRIPE_PORTAL_RETURN_URL ??
  'http://localhost:5173/app/assinatura';
const STRIPE_CONFIGURED: boolean = Boolean(process.env.STRIPE_SECRET_KEY);

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
    const planId = dto.planId;
    const billingInterval = this.parseBillingInterval(dto.billingInterval);

    // 1. Validate plan exists and is active
    const plan = await this.prisma.plan.findUnique({
      where: { id: planId },
    });

    if (!plan || !plan.isActive) {
      throw new NotFoundException('Plano não encontrado ou inativo.');
    }

    // 2. Resolve the Stripe price ID for the chosen billing interval
    const priceId =
      billingInterval === 'MONTHLY'
        ? plan.stripePriceIdMonthly
        : plan.stripePriceIdYearly;

    if (!priceId) {
      const intervalLabel = billingInterval === 'MONTHLY' ? 'mensal' : 'anual';
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
        planId,
        stripeCustomerId,
        billingInterval,
        status: 'TRIALING',
      },
      update: {
        planId,
        stripeCustomerId,
        billingInterval,
        // status is intentionally NOT updated here — only the webhook may
        // transition an already-active subscription.
      },
    });

    // 6. Create the Stripe Checkout Session
    const session = await this.stripe.getClient().checkout.sessions.create({
      mode: 'subscription',
      customer: stripeCustomerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: STRIPE_SUCCESS_URL,
      cancel_url: STRIPE_CANCEL_URL,
      metadata: {
        clinicId,
        planId,
        billingInterval,
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

  async getPlans() {
    const plans = await this.prisma.plan.findMany({
      where: { isActive: true, isPublic: true },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        priceMonthly: true,
        priceYearly: true,
        stripePriceIdMonthly: true,
        stripePriceIdYearly: true,
        maxProfiles: true,
        maxLeadsPerMonth: true,
        maxServicesPerProfile: true,
        hasAppointments: true,
        hasAnalytics: true,
        hasCustomDomain: true,
        hasPrioritySupport: true,
        displayOrder: true,
      },
      orderBy: { displayOrder: 'asc' },
    });

    return plans.map(
      ({ stripePriceIdMonthly, stripePriceIdYearly, ...plan }) => ({
        ...plan,
        hasMonthlyPrice: stripePriceIdMonthly !== null,
        hasYearlyPrice: stripePriceIdYearly !== null,
      }),
    );
  }

  async getSubscription(clinicId: string) {
    return this.prisma.subscription.findUnique({
      where: { clinicId },
      select: {
        id: true,
        status: true,
        billingInterval: true,
        trialEndsAt: true,
        currentPeriodStart: true,
        currentPeriodEnd: true,
        cancelAtPeriodEnd: true,
        canceledAt: true,
        createdAt: true,
        updatedAt: true,
        plan: {
          select: {
            id: true,
            name: true,
            slug: true,
            priceMonthly: true,
            priceYearly: true,
          },
        },
      },
    });
  }

  async createPortalSession(clinicId: string): Promise<{ url: string }> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { clinicId },
    });

    if (!subscription) {
      throw new NotFoundException(
        'Nenhuma assinatura encontrada para esta clínica.',
      );
    }

    if (!subscription.stripeCustomerId) {
      throw new BadRequestException(
        'Esta clínica ainda não possui um cliente de cobrança registrado. Conclua o processo de assinatura primeiro.',
      );
    }

    const session = await this.stripe
      .getClient()
      .billingPortal.sessions.create({
        customer: subscription.stripeCustomerId,
        return_url: STRIPE_PORTAL_RETURN_URL,
      });

    return { url: session.url };
  }

  async cancelSubscription(clinicId: string): Promise<{
    message: string;
    cancelAtPeriodEnd: boolean;
    currentPeriodEnd: Date | null;
  }> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { clinicId },
    });

    if (
      !subscription ||
      !this.isCancellableSubscriptionStatus(subscription.status)
    ) {
      throw new NotFoundException(
        'Nenhuma assinatura ativa encontrada para esta clínica.',
      );
    }

    if (!subscription.stripeSubscriptionId) {
      throw new BadRequestException(
        'Esta assinatura ainda não possui um ID de cobrança registrado. Tente novamente em instantes.',
      );
    }

    await this.stripe
      .getClient()
      .subscriptions.update(subscription.stripeSubscriptionId, {
        cancel_at_period_end: true,
      });

    // Optimistically reflect the pending cancellation locally.
    // The webhook (customer.subscription.updated) will confirm and sync
    // the final state (canceledAt, status) when Stripe delivers it.
    await this.prisma.subscription.update({
      where: { clinicId },
      data: { cancelAtPeriodEnd: true },
    });

    const periodEndLabel = subscription.currentPeriodEnd
      ? ` até ${subscription.currentPeriodEnd.toLocaleDateString('pt-BR')}`
      : '';

    return {
      message: `Assinatura agendada para cancelamento ao final do período${periodEndLabel}. Você continuará tendo acesso até lá.`,
      cancelAtPeriodEnd: true,
      currentPeriodEnd: subscription.currentPeriodEnd,
    };
  }

  getTemplate() {
    return {
      module: 'billing',
      ready: true,
      stripeConfigured: STRIPE_CONFIGURED,
    };
  }

  private parseBillingInterval(billingInterval: unknown): BillingIntervalValue {
    if (billingInterval === 'MONTHLY') {
      return 'MONTHLY';
    }

    if (billingInterval === 'YEARLY') {
      return 'YEARLY';
    }

    throw new BadRequestException('billingInterval deve ser MONTHLY ou YEARLY');
  }

  private isCancellableSubscriptionStatus(
    status: string,
  ): status is CancellableSubscriptionStatus {
    return CANCELLABLE_SUBSCRIPTION_STATUSES.includes(
      status as CancellableSubscriptionStatus,
    );
  }
}
