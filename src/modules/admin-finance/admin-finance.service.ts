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
  SubscriptionStatus.TRIALING,
];

@Injectable()
export class AdminFinanceService {
  constructor(private readonly prisma: PrismaService) {}

  async getSummary() {
    const [plans, subscriptions, stripeEventsTotal, stripeEventsProcessed, stripeEventsFailed] =
      await Promise.all([
        this.prisma.plan.findMany({ orderBy: { displayOrder: 'asc' } }),
        this.prisma.subscription.findMany({ include: { plan: true, clinic: true } }),
        this.prisma.stripeEvent.count(),
        this.prisma.stripeEvent.count({ where: { processed: true } }),
        this.prisma.stripeEvent.count({
          where: { processed: false, errorMessage: { not: null } },
        }),
      ]);

    const statusCounts = this.countBy(subscriptions, (item) => item.status);
    const subscriptionsByPlan = plans.map((plan) => {
      const planSubscriptions = subscriptions.filter((item) => item.planId === plan.id);
      const activeSubscriptions = planSubscriptions.filter((item) =>
        ACTIVE_REVENUE_STATUSES.includes(item.status),
      );
      const estimatedMrr = activeSubscriptions.length * plan.priceMonthly;

      return {
        planId: plan.id,
        planName: plan.name,
        activeSubscriptions: activeSubscriptions.length,
        totalSubscriptions: planSubscriptions.length,
        estimatedMrr,
      };
    });
    const estimatedMrr = subscriptionsByPlan.reduce(
      (total, item) => total + item.estimatedMrr,
      0,
    );

    return {
      kpis: {
        totalPlans: plans.length,
        activePlans: plans.filter((plan) => plan.isActive).length,
        activeSubscriptions: statusCounts.ACTIVE ?? 0,
        trialSubscriptions: statusCounts.TRIALING ?? 0,
        canceledSubscriptions: statusCounts.CANCELED ?? 0,
        pastDueSubscriptions: (statusCounts.PAST_DUE ?? 0) + (statusCounts.UNPAID ?? 0),
        estimatedMrr,
        estimatedArr: estimatedMrr * 12,
        stripeEventsTotal,
        stripeEventsProcessed,
        stripeEventsFailed,
      },
      statusDistribution: Object.values(SubscriptionStatus).map((status) => ({
        status,
        count: statusCounts[status] ?? 0,
      })),
      subscriptionsByPlan,
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
        include: { clinic: true, plan: true },
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
        stripeCustomerId: subscription.stripeCustomerId,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        status: subscription.status,
        trialEndsAt: subscription.trialEndsAt,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        canceledAt: subscription.canceledAt,
        endedAt: subscription.endedAt,
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
