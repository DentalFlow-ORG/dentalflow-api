import { Injectable } from '@nestjs/common';
import { Prisma, SubscriptionStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

type ListSubscriptionsQuery = {
  page: number;
  limit: number;
  status?: string;
  planId?: string;
  search?: string;
  from?: string;
  to?: string;
};

type ListStripeEventsQuery = {
  page: number;
  limit: number;
  processed?: string;
  type?: string;
  from?: string;
  to?: string;
};

const ACTIVE_REVENUE_STATUSES: SubscriptionStatus[] = [
  SubscriptionStatus.ACTIVE,
];
const DEFAULT_CURRENCY = 'BRL';
const RECENT_LIMIT = 8;

@Injectable()
export class AdminFinanceService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary() {
    const plans = await this.prisma.plan.findMany({
      orderBy: { displayOrder: 'asc' },
    });
    const subscriptions = await this.prisma.subscription.findMany({
      include: { plan: true, clinic: true, items: true },
    });
    const stripeEventsTotal = await this.prisma.stripeEvent.count();
    const stripeEventsProcessed = await this.prisma.stripeEvent.count({
      where: { processed: true },
    });
    const stripeEventsFailed = await this.prisma.stripeEvent.count({
      where: { processed: false, errorMessage: { not: null } },
    });

    const statusCounts = this.countBy(subscriptions, (item) => item.status);
    const revenueRows = subscriptions.flatMap((subscription) =>
      this.subscriptionRevenueRows(subscription),
    );
    const activeRevenueRows = revenueRows.filter(
      (row) => row.status === SubscriptionStatus.ACTIVE,
    );
    const revenueByCurrency = this.groupRevenueByCurrency(activeRevenueRows);
    const primaryCurrency = revenueByCurrency[0]?.currency ?? DEFAULT_CURRENCY;
    const primaryCurrencyRevenue = revenueByCurrency.find(
      (item) => item.currency === primaryCurrency,
    );
    const subscriptionsByPlan = plans.map((plan) => {
      const planSubscriptions = subscriptions.filter((item) => item.planId === plan.id);
      const planRevenueRows = activeRevenueRows.filter((item) => item.planId === plan.id);
      const estimatedMrr = planRevenueRows.reduce((total, item) => total + item.mrr, 0);
      const estimatedArr = planRevenueRows.reduce((total, item) => total + item.arr, 0);
      const currencies = [...new Set(planRevenueRows.map((item) => item.currency))];

      return {
        planId: plan.id,
        planName: plan.name,
        activeSubscriptions: planSubscriptions.filter(
          (item) => item.status === SubscriptionStatus.ACTIVE,
        ).length,
        trialSubscriptions: planSubscriptions.filter(
          (item) => item.status === SubscriptionStatus.TRIALING,
        ).length,
        canceledSubscriptions: planSubscriptions.filter(
          (item) => item.status === SubscriptionStatus.CANCELED,
        ).length,
        pastDueSubscriptions: planSubscriptions.filter((item) =>
          item.status === SubscriptionStatus.PAST_DUE ||
          item.status === SubscriptionStatus.UNPAID,
        ).length,
        totalSubscriptions: planSubscriptions.length,
        subscriberCount: new Set(planRevenueRows.map((item) => item.subscriptionId)).size,
        estimatedMrr,
        estimatedArr,
        currency: currencies.length === 1 ? currencies[0] : primaryCurrency,
      };
    });
    const revenueByPrice = Object.values(
      activeRevenueRows.reduce<
        Record<
          string,
          {
            stripePriceId: string;
            priceNickname: string | null;
            planId: string;
            planName: string;
            currency: string;
            billingInterval: string | null;
            subscriberIds: Set<string>;
            estimatedMrr: number;
            estimatedArr: number;
          }
        >
      >((groups, row) => {
        const key = `${row.stripePriceId}:${row.currency}`;
        const current =
          groups[key] ??
          {
            stripePriceId: row.stripePriceId,
            priceNickname: row.priceNickname,
            planId: row.planId,
            planName: row.planName,
            currency: row.currency,
            billingInterval: row.billingInterval,
            subscriberIds: new Set<string>(),
            estimatedMrr: 0,
            estimatedArr: 0,
          };

        current.subscriberIds.add(row.subscriptionId);
        current.estimatedMrr += row.mrr;
        current.estimatedArr += row.arr;
        groups[key] = current;
        return groups;
      }, {}),
    ).map(({ subscriberIds, ...item }) => ({
      ...item,
      subscriberCount: subscriberIds.size,
    }));
    const recentlyCreatedSubscriptions = subscriptions
      .slice()
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, RECENT_LIMIT)
      .map((subscription) => this.subscriptionPreview(subscription));
    const recentlyCanceledSubscriptions = subscriptions
      .filter((subscription) => subscription.canceledAt || subscription.endedAt)
      .sort(
        (a, b) =>
          (b.canceledAt ?? b.endedAt ?? b.updatedAt).getTime() -
          (a.canceledAt ?? a.endedAt ?? a.updatedAt).getTime(),
      )
      .slice(0, RECENT_LIMIT)
      .map((subscription) => this.subscriptionPreview(subscription));
    const estimatedMrr = primaryCurrencyRevenue?.estimatedMrr ?? 0;
    const estimatedArr = primaryCurrencyRevenue?.estimatedArr ?? 0;

    return {
      kpis: {
        totalPlans: plans.length,
        activePlans: plans.filter((plan) => plan.isActive).length,
        activeSubscriptions: statusCounts.ACTIVE ?? 0,
        trialSubscriptions: statusCounts.TRIALING ?? 0,
        canceledSubscriptions: statusCounts.CANCELED ?? 0,
        pastDueSubscriptions: (statusCounts.PAST_DUE ?? 0) + (statusCounts.UNPAID ?? 0),
        estimatedMrr,
        estimatedArr,
        currency: primaryCurrency,
        stripeEventsTotal,
        stripeEventsProcessed,
        stripeEventsFailed,
      },
      revenueByCurrency,
      statusDistribution: Object.values(SubscriptionStatus).map((status) => ({
        status,
        count: statusCounts[status] ?? 0,
      })),
      subscriptionsByPlan,
      revenueByPrice,
      recentlyCreatedSubscriptions,
      recentlyCanceledSubscriptions,
    };
  }

  async listSubscriptions(query: ListSubscriptionsQuery) {
    const page = this.normalizePage(query.page);
    const limit = this.normalizeLimit(query.limit);
    const where: Prisma.SubscriptionWhereInput = {
      ...(this.isSubscriptionStatus(query.status) ? { status: query.status } : {}),
      ...(query.planId ? { planId: query.planId } : {}),
      ...(query.search?.trim()
        ? { clinic: { name: { contains: query.search.trim(), mode: 'insensitive' } } }
        : {}),
      ...this.createdAtRange(query.from, query.to),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.subscription.findMany({
        where,
        include: { clinic: true, plan: true, items: true },
        orderBy: [{ createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.subscription.count({ where }),
    ]);

    return {
      data: data.map((subscription) => ({
        id: subscription.id,
        clinic: {
          id: subscription.clinic.id,
          name: subscription.clinic.name,
          email: subscription.clinic.email,
        },
        plan: {
          id: subscription.plan.id,
          name: subscription.plan.name,
          slug: subscription.plan.slug,
          priceMonthly: subscription.plan.priceMonthly,
          priceYearly: subscription.plan.priceYearly,
        },
        status: subscription.status,
        trialEndsAt: subscription.trialEndsAt,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        canceledAt: subscription.canceledAt,
        endedAt: subscription.endedAt,
        items: subscription.items.map((item) => ({
          id: item.id,
          stripePriceId: item.stripePriceId,
          priceNickname: item.priceNickname,
          billingInterval: item.billingInterval,
          unitAmount: item.unitAmount,
          unitAmountDecimal: item.unitAmountDecimal,
          currency: item.currency,
          quantity: item.quantity,
        })),
        createdAt: subscription.createdAt,
        updatedAt: subscription.updatedAt,
      })),
      total,
      page,
      limit,
    };
  }

  async listPlans() {
    const plans = await this.prisma.plan.findMany({
      include: { subscriptions: true },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    });

    return plans.map((plan) => ({
      id: plan.id,
      name: plan.name,
      slug: plan.slug,
      description: plan.description,
      stripePriceIdMonthly: plan.stripePriceIdMonthly,
      stripePriceIdYearly: plan.stripePriceIdYearly,
      priceMonthly: plan.priceMonthly,
      priceYearly: plan.priceYearly,
      maxProfiles: plan.maxProfiles,
      maxLeadsPerMonth: plan.maxLeadsPerMonth,
      maxServicesPerProfile: plan.maxServicesPerProfile,
      hasAppointments: plan.hasAppointments,
      hasAnalytics: plan.hasAnalytics,
      hasCustomDomain: plan.hasCustomDomain,
      hasPrioritySupport: plan.hasPrioritySupport,
      isActive: plan.isActive,
      isPublic: plan.isPublic,
      displayOrder: plan.displayOrder,
      subscriptionsCount: plan.subscriptions.length,
      activeSubscriptionsCount: plan.subscriptions.filter((subscription) =>
        ACTIVE_REVENUE_STATUSES.includes(subscription.status),
      ).length,
      trialSubscriptionsCount: plan.subscriptions.filter(
        (subscription) => subscription.status === SubscriptionStatus.TRIALING,
      ).length,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    }));
  }

  async listStripeEvents(query: ListStripeEventsQuery) {
    const page = this.normalizePage(query.page);
    const limit = this.normalizeLimit(query.limit);
    const where: Prisma.StripeEventWhereInput = {
      ...(query.processed === 'true' ? { processed: true } : {}),
      ...(query.processed === 'false' ? { processed: false } : {}),
      ...(query.type?.trim() ? { type: { contains: query.type.trim(), mode: 'insensitive' } } : {}),
      ...this.receivedAtRange(query.from, query.to),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.stripeEvent.findMany({
        where,
        orderBy: [{ receivedAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.stripeEvent.count({ where }),
    ]);

    return {
      data: data.map((event) => ({
        id: event.id,
        type: event.type,
        processed: event.processed,
        processedAt: event.processedAt,
        errorMessage: event.errorMessage,
        createdAt: event.createdAt,
        receivedAt: event.receivedAt,
      })),
      total,
      page,
      limit,
    };
  }

  private countBy<T>(items: T[], getKey: (item: T) => string) {
    return items.reduce<Record<string, number>>((counts, item) => {
      const key = getKey(item);
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {});
  }

  private subscriptionRevenueRows(
    subscription: Prisma.SubscriptionGetPayload<{
      include: { plan: true; clinic: true; items: true };
    }>,
  ) {
    const items =
      subscription.items.length > 0
        ? subscription.items.map((item) => ({
            stripePriceId: item.stripePriceId,
            priceNickname: item.priceNickname,
            billingInterval: item.billingInterval ?? subscription.billingInterval,
            unitAmount: item.unitAmount,
            unitAmountDecimal: item.unitAmountDecimal,
            currency: item.currency,
            quantity: item.quantity,
          }))
        : [
            {
              stripePriceId:
                subscription.billingInterval === 'YEARLY'
                  ? (subscription.plan.stripePriceIdYearly ?? subscription.plan.id)
                  : (subscription.plan.stripePriceIdMonthly ?? subscription.plan.id),
              priceNickname: subscription.plan.name,
              billingInterval: subscription.billingInterval,
              unitAmount:
                subscription.billingInterval === 'YEARLY'
                  ? subscription.plan.priceYearly
                  : subscription.plan.priceMonthly,
              unitAmountDecimal: null,
              currency: DEFAULT_CURRENCY,
              quantity: 1,
            },
          ];

    return items.map((item) => {
      const amount = this.resolveAmount(item.unitAmount, item.unitAmountDecimal);
      const quantity = item.quantity || 1;
      const totalAmount = amount * quantity;
      const isYearly = item.billingInterval === 'YEARLY';

      return {
        subscriptionId: subscription.id,
        status: subscription.status,
        planId: subscription.planId,
        planName: subscription.plan.name,
        stripePriceId: item.stripePriceId,
        priceNickname: item.priceNickname,
        billingInterval: item.billingInterval,
        currency: item.currency || DEFAULT_CURRENCY,
        mrr: isYearly ? totalAmount / 12 : totalAmount,
        arr: isYearly ? totalAmount : totalAmount * 12,
      };
    });
  }

  private resolveAmount(unitAmount: number | null, unitAmountDecimal: string | null) {
    if (unitAmount !== null) return unitAmount;

    const parsed = unitAmountDecimal ? Number(unitAmountDecimal) : 0;
    return Number.isFinite(parsed) ? parsed : 0;
  }

  private groupRevenueByCurrency(
    rows: Array<{ currency: string; mrr: number; arr: number }>,
  ) {
    return Object.values(
      rows.reduce<Record<string, { currency: string; estimatedMrr: number; estimatedArr: number }>>(
        (groups, row) => {
          const currency = row.currency || DEFAULT_CURRENCY;
          const current = groups[currency] ?? {
            currency,
            estimatedMrr: 0,
            estimatedArr: 0,
          };
          current.estimatedMrr += row.mrr;
          current.estimatedArr += row.arr;
          groups[currency] = current;
          return groups;
        },
        {},
      ),
    ).sort((a, b) => b.estimatedMrr - a.estimatedMrr);
  }

  private subscriptionPreview(
    subscription: Prisma.SubscriptionGetPayload<{
      include: { plan: true; clinic: true; items: true };
    }>,
  ) {
    return {
      id: subscription.id,
      clinic: {
        id: subscription.clinic.id,
        name: subscription.clinic.name,
        email: subscription.clinic.email,
      },
      plan: {
        id: subscription.plan.id,
        name: subscription.plan.name,
        slug: subscription.plan.slug,
      },
      status: subscription.status,
      billingInterval: subscription.billingInterval,
      currency: subscription.items[0]?.currency ?? DEFAULT_CURRENCY,
      createdAt: subscription.createdAt,
      currentPeriodEnd: subscription.currentPeriodEnd,
      canceledAt: subscription.canceledAt,
      endedAt: subscription.endedAt,
    };
  }

  private normalizePage(page: number) {
    return Number.isFinite(page) && page > 0 ? page : 1;
  }

  private normalizeLimit(limit: number) {
    if (!Number.isFinite(limit) || limit < 1) return 20;
    return Math.min(limit, 100);
  }

  private isSubscriptionStatus(value?: string): value is SubscriptionStatus {
    return Object.values(SubscriptionStatus).includes(value as SubscriptionStatus);
  }

  private createdAtRange(from?: string, to?: string): Prisma.SubscriptionWhereInput {
    const range = this.dateRange(from, to);
    return range ? { createdAt: range } : {};
  }

  private receivedAtRange(from?: string, to?: string): Prisma.StripeEventWhereInput {
    const range = this.dateRange(from, to);
    return range ? { receivedAt: range } : {};
  }

  private dateRange(from?: string, to?: string) {
    const range: Prisma.DateTimeFilter = {};
    if (from) range.gte = new Date(`${from}T00:00:00.000Z`);
    if (to) range.lte = new Date(`${to}T23:59:59.999Z`);
    return Object.keys(range).length > 0 ? range : null;
  }
}
