import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { BillingInterval, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { launchCampaignConfig } from './billing-campaign.config';
import { ChangeSubscriptionPlanDto } from './dto/change-subscription-plan.dto';
import { CreateCheckoutSessionDto } from './dto/create-checkout-session.dto';
import { StartTrialDto } from './dto/start-trial.dto';
import { StripeService } from './stripe.service';

type BillingIntervalValue = 'MONTHLY' | 'YEARLY';
type CancellableSubscriptionStatus = 'ACTIVE' | 'TRIALING' | 'PAST_DUE';
type NormalizedBillingStatus =
  | 'missing'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'unpaid'
  | 'paused';

const CANCELLABLE_SUBSCRIPTION_STATUSES: CancellableSubscriptionStatus[] = [
  'ACTIVE',
  'TRIALING',
  'PAST_DUE',
];
const TRIAL_DAYS = 7;
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
  private readonly logger = new Logger(BillingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
  ) {}

  async createCheckoutSession(
    clinicId: string,
    userId: string,
    dto: CreateCheckoutSessionDto,
  ): Promise<{ url: string }> {
    const billingInterval = this.parseBillingInterval(dto.billingInterval);
    const plan = await this.resolvePublicPlan(dto);
    const launchCoupon = this.getLaunchCoupon(plan.slug, billingInterval);

    if (
      this.isLaunchCampaignActive() &&
      launchCampaignConfig.promotionalPrices[plan.slug]?.monthly &&
      !launchCoupon
    ) {
      this.logger.warn(
        `Checkout for plan "${plan.slug}" without promotional coupon — set STRIPE_LAUNCH_COUPON_${plan.slug.toUpperCase()}_MONTHLY to apply the launch discount.`,
      );
    }

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

    const existingSubscription = await this.prisma.subscription.findUnique({
      where: { clinicId },
    });
    const clinic = await this.prisma.clinic.findUniqueOrThrow({
      where: { id: clinicId },
      select: { name: true, email: true },
    });

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

    await this.prisma.subscription.upsert({
      where: { clinicId },
      create: {
        clinicId,
        planId: plan.id,
        stripeCustomerId,
        billingInterval,
        status: SubscriptionStatus.INCOMPLETE,
      },
      update: {
        planId: plan.id,
        stripeCustomerId,
        billingInterval,
      },
    });

    const session = await this.stripe.getClient().checkout.sessions.create({
      mode: 'subscription',
      customer: stripeCustomerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: STRIPE_SUCCESS_URL,
      cancel_url: STRIPE_CANCEL_URL,
      discounts: launchCoupon ? [{ coupon: launchCoupon }] : undefined,
      metadata: {
        clinicId,
        planId: plan.id,
        billingInterval,
        userId,
        launchCampaignApplied: launchCoupon ? 'true' : 'false',
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

    const campaign = this.getLaunchCampaign();

    return {
      plans: plans.map(
        ({ stripePriceIdMonthly, stripePriceIdYearly, ...plan }) => ({
          ...plan,
          hasMonthlyPrice: stripePriceIdMonthly !== null,
          hasYearlyPrice: stripePriceIdYearly !== null,
          trialEligible: true,
          annualDiscountPercent: this.calculateAnnualDiscountPercent(
            plan.priceMonthly,
            plan.priceYearly,
          ),
          campaign: this.getPlanCampaign(plan.slug, plan.priceMonthly),
        }),
      ),
      campaign,
    };
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

  async getCurrentSubscriptionStatus(clinicId: string) {
    const subscription = await this.prisma.subscription.findUnique({
      where: { clinicId },
      select: {
        id: true,
        status: true,
        billingInterval: true,
        stripeCustomerId: true,
        stripeSubscriptionId: true,
        trialEndsAt: true,
        currentPeriodEnd: true,
        cancelAtPeriodEnd: true,
        canceledAt: true,
        endedAt: true,
        plan: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
      },
    });

    if (!subscription) {
      return {
        hasSubscription: false,
        status: 'missing' as NormalizedBillingStatus,
        planKey: null,
        planName: null,
        billingInterval: null,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        trialEndsAt: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        accessAllowed: false,
        requiresPlanSelection: true,
        requiresPayment: false,
        message: 'Nenhuma assinatura encontrada.',
      };
    }

    const normalizedStatus = this.normalizeStatus(subscription.status);
    const accessAllowed = this.isAccessAllowed(subscription);

    return {
      hasSubscription: true,
      status: normalizedStatus,
      planKey: subscription.plan?.slug ?? null,
      planName: subscription.plan?.name ?? null,
      billingInterval: this.normalizeInterval(subscription.billingInterval),
      stripeCustomerId: subscription.stripeCustomerId,
      stripeSubscriptionId: subscription.stripeSubscriptionId,
      trialEndsAt: subscription.trialEndsAt,
      currentPeriodEnd: subscription.currentPeriodEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
      accessAllowed,
      requiresPlanSelection: !accessAllowed && normalizedStatus === 'missing',
      requiresPayment: !accessAllowed && normalizedStatus !== 'missing',
      message: this.getBillingStatusMessage(normalizedStatus, accessAllowed),
    };
  }

  async startTrial(clinicId: string, dto: StartTrialDto) {
    const billingInterval = this.parseBillingInterval(dto.billingInterval);
    const plan = await this.resolvePublicPlan({ planKey: dto.planKey });

    const existingSubscription = await this.prisma.subscription.findUnique({
      where: { clinicId },
    });

    if (existingSubscription?.trialEndsAt) {
      throw new BadRequestException(
        'O teste grátis já foi utilizado por esta clínica.',
      );
    }

    if (
      existingSubscription?.stripeSubscriptionId &&
      existingSubscription.status !== SubscriptionStatus.CANCELED
    ) {
      throw new BadRequestException(
        'Esta clínica já possui uma assinatura vinculada à cobrança.',
      );
    }

    const trialEndsAt = new Date(Date.now() + TRIAL_DAYS * 86_400_000);

    await this.prisma.subscription.upsert({
      where: { clinicId },
      create: {
        clinicId,
        planId: plan.id,
        billingInterval,
        status: SubscriptionStatus.TRIALING,
        trialEndsAt,
      },
      update: {
        planId: plan.id,
        billingInterval,
        status: SubscriptionStatus.TRIALING,
        trialEndsAt,
        cancelAtPeriodEnd: false,
        canceledAt: null,
        endedAt: null,
      },
    });

    return this.getCurrentSubscriptionStatus(clinicId);
  }

  async changeSubscriptionPlan(
    clinicId: string,
    dto: ChangeSubscriptionPlanDto,
  ) {
    const billingInterval = this.parseBillingInterval(dto.billingInterval);
    const plan = await this.resolvePublicPlan({ planKey: dto.planKey });
    const priceId =
      billingInterval === 'MONTHLY'
        ? plan.stripePriceIdMonthly
        : plan.stripePriceIdYearly;

    if (!priceId) {
      const intervalLabel = billingInterval === 'MONTHLY' ? 'mensal' : 'anual';
      throw new BadRequestException(
        `Este plano não possui um preço ${intervalLabel} configurado.`,
      );
    }

    const subscription = await this.prisma.subscription.findUnique({
      where: { clinicId },
    });

    if (!subscription?.stripeSubscriptionId) {
      throw new BadRequestException(
        'Nenhuma assinatura ativa da Stripe foi encontrada para alteração de plano.',
      );
    }

    const changeableStatuses: SubscriptionStatus[] = [
      SubscriptionStatus.ACTIVE,
      SubscriptionStatus.TRIALING,
      SubscriptionStatus.PAST_DUE,
    ];

    if (!changeableStatuses.includes(subscription.status)) {
      throw new BadRequestException(
        'Esta assinatura não está em um estado permitido para troca de plano.',
      );
    }

    const stripeSubscription = await this.stripe
      .getClient()
      .subscriptions.retrieve(subscription.stripeSubscriptionId);
    const subscriptionItem = stripeSubscription.items.data[0];

    if (!subscriptionItem) {
      throw new BadRequestException(
        'A assinatura atual não possui item de cobrança para atualização.',
      );
    }

    const updatedSubscription = await this.stripe
      .getClient()
      .subscriptions.update(subscription.stripeSubscriptionId, {
        items: [{ id: subscriptionItem.id, price: priceId }],
        proration_behavior: 'create_prorations',
        metadata: {
          clinicId,
          planId: plan.id,
          billingInterval,
          changePlanRequestedAt: new Date().toISOString(),
        },
      });

    const firstItem = updatedSubscription.items.data[0];
    await this.prisma.subscription.update({
      where: { clinicId },
      data: {
        planId: plan.id,
        billingInterval,
        status: this.mapStripeStatus(updatedSubscription.status),
        currentPeriodStart: firstItem
          ? new Date(firstItem.current_period_start * 1000)
          : undefined,
        currentPeriodEnd: firstItem
          ? new Date(firstItem.current_period_end * 1000)
          : undefined,
        cancelAtPeriodEnd: updatedSubscription.cancel_at_period_end,
        canceledAt: updatedSubscription.canceled_at
          ? new Date(updatedSubscription.canceled_at * 1000)
          : null,
      },
    });

    return this.getCurrentSubscriptionStatus(clinicId);
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

  private async resolvePublicPlan(dto: { planId?: string; planKey?: string }) {
    const planId = dto.planId?.trim();
    const planKey = dto.planKey?.trim();

    if (!planId && !planKey) {
      throw new BadRequestException('Informe o plano desejado.');
    }

    const plan = await this.prisma.plan.findFirst({
      where: {
        isActive: true,
        isPublic: true,
        ...(planId ? { id: planId } : { slug: planKey }),
      },
    });

    if (!plan) {
      throw new NotFoundException('Plano não encontrado ou inativo.');
    }

    return plan;
  }

  private calculateAnnualDiscountPercent(
    priceMonthly: number,
    priceYearly: number,
  ) {
    if (priceMonthly <= 0 || priceYearly <= 0) return null;
    return Math.max(
      0,
      Math.round(
        ((priceMonthly * 12 - priceYearly) / (priceMonthly * 12)) * 100,
      ),
    );
  }

  private getLaunchCampaign() {
    const enabled = this.isLaunchCampaignActive();

    return {
      name: launchCampaignConfig.name,
      enabled,
      totalSpots: launchCampaignConfig.totalSpots,
      claimedSpots: launchCampaignConfig.claimedSpots,
      promotionEndDate: launchCampaignConfig.promotionEndDate,
      promotionalPrices: launchCampaignConfig.promotionalPrices,
      compareAtPrices: launchCampaignConfig.compareAtPrices,
      message: enabled
        ? 'Primeiro mês com condição especial para as 100 primeiras clínicas.'
        : 'Oferta encerrada.',
    };
  }

  private getPlanCampaign(planKey: string, monthlyPrice: number) {
    const enabled = this.isLaunchCampaignActive();
    const promotionalPrice =
      launchCampaignConfig.promotionalPrices[planKey]?.monthly ?? null;
    const configuredCompareAt =
      launchCampaignConfig.compareAtPrices[planKey]?.monthly ?? null;
    const coupon = this.getLaunchCoupon(planKey, 'MONTHLY');
    const promotionReady = Boolean(enabled && promotionalPrice && coupon);

    return {
      enabled,
      promotionalPriceMonthly: promotionalPrice,
      compareAtPriceMonthly: monthlyPrice || configuredCompareAt,
      promotionReady,
      couponConfigured: Boolean(coupon),
    };
  }

  private getLaunchCoupon(
    planKey: string,
    billingInterval: BillingIntervalValue,
  ): string | null {
    if (!this.isLaunchCampaignActive()) return null;
    return launchCampaignConfig.coupons[planKey]?.[billingInterval] ?? null;
  }

  private isLaunchCampaignActive() {
    if (!launchCampaignConfig.enabled) return false;
    const endsAt = new Date(launchCampaignConfig.promotionEndDate);
    if (Number.isNaN(endsAt.getTime())) return false;
    return endsAt.getTime() > Date.now();
  }

  private mapStripeStatus(stripeStatus: string): SubscriptionStatus {
    const map: Record<string, SubscriptionStatus> = {
      trialing: SubscriptionStatus.TRIALING,
      active: SubscriptionStatus.ACTIVE,
      past_due: SubscriptionStatus.PAST_DUE,
      canceled: SubscriptionStatus.CANCELED,
      unpaid: SubscriptionStatus.UNPAID,
      paused: SubscriptionStatus.PAUSED,
      incomplete: SubscriptionStatus.INCOMPLETE,
      incomplete_expired: SubscriptionStatus.CANCELED,
    };

    return map[stripeStatus] ?? SubscriptionStatus.INCOMPLETE;
  }

  private normalizeInterval(interval: BillingInterval | null) {
    if (interval === BillingInterval.MONTHLY) return 'monthly';
    if (interval === BillingInterval.YEARLY) return 'annual';
    return null;
  }

  private normalizeStatus(status: SubscriptionStatus): NormalizedBillingStatus {
    const map: Record<SubscriptionStatus, NormalizedBillingStatus> = {
      TRIALING: 'trialing',
      ACTIVE: 'active',
      PAST_DUE: 'past_due',
      CANCELED: 'canceled',
      UNPAID: 'unpaid',
      PAUSED: 'paused',
      INCOMPLETE: 'incomplete',
    };

    return map[status];
  }

  private isAccessAllowed(subscription: {
    status: SubscriptionStatus;
    trialEndsAt: Date | null;
    currentPeriodEnd: Date | null;
  }) {
    const now = new Date();

    if (subscription.status === SubscriptionStatus.ACTIVE) {
      return true;
    }

    if (subscription.status === SubscriptionStatus.TRIALING) {
      return Boolean(
        subscription.trialEndsAt && subscription.trialEndsAt > now,
      );
    }

    if (subscription.status === SubscriptionStatus.CANCELED) {
      return Boolean(
        subscription.currentPeriodEnd && subscription.currentPeriodEnd > now,
      );
    }

    return false;
  }

  private getBillingStatusMessage(
    status: NormalizedBillingStatus,
    accessAllowed: boolean,
  ) {
    if (accessAllowed && status === 'trialing') {
      return 'Teste grátis ativo.';
    }

    if (accessAllowed) {
      return 'Assinatura com acesso liberado.';
    }

    const messages: Record<NormalizedBillingStatus, string> = {
      missing: 'Nenhuma assinatura encontrada.',
      trialing: 'Seu teste grátis expirou. Escolha um plano para continuar.',
      active: 'Assinatura ativa.',
      past_due: 'Seu pagamento está pendente.',
      canceled: 'Sua assinatura está cancelada.',
      incomplete: 'Sua assinatura ainda não foi concluída.',
      unpaid: 'Sua assinatura está sem pagamento confirmado.',
      paused: 'Sua assinatura está pausada.',
    };

    return messages[status];
  }

  private isCancellableSubscriptionStatus(
    status: string,
  ): status is CancellableSubscriptionStatus {
    return CANCELLABLE_SUBSCRIPTION_STATUSES.includes(
      status as CancellableSubscriptionStatus,
    );
  }
}
