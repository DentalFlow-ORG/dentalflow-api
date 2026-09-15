import '../../src/config/load-env';

import { PrismaPg } from '@prisma/adapter-pg';
import {
  BillingInterval,
  PrismaClient,
  SubscriptionStatus,
} from '@prisma/client';
import { Pool } from 'pg';
import type StripeConstructor from 'stripe';

import { databaseConfig } from '../../src/config/database.config';
import { stripeConfig } from '../../src/config/stripe.config';
import {
  hasScheduledCancellation,
  mapStripePriceInterval,
  mapStripeSubscriptionStatus,
} from '../../src/modules/billing/billing-stripe-mappers';

const stripeModule: unknown = module.require('stripe');
const Stripe = stripeModule as typeof StripeConstructor;

type Selector = {
  email?: string;
  stripeCustomerId?: string;
  stripeSubscriptionId?: string;
  clinicId?: string;
  dryRun: boolean;
};

export type StripeSubscription = {
  id: string;
  status: string;
  created: number;
  customer: string | { id: string } | null;
  metadata?: Record<string, string> | null;
  items: { data: StripeSubscriptionItem[] };
  trial_end?: number | null;
  cancel_at_period_end: boolean;
  cancel_at?: number | null;
  canceled_at?: number | null;
  ended_at?: number | null;
};
type StripeCustomer = {
  id: string;
  metadata?: Record<string, string> | null;
  deleted?: boolean | void;
};
type StripeSubscriptionItem = {
  id: string;
  quantity?: number | null;
  current_period_start: number;
  current_period_end: number;
  price: {
    id: string;
    nickname?: string | null;
    recurring?: { interval?: string | null } | null;
    unit_amount?: number | null;
    unit_amount_decimal?: string | null;
    currency: string;
  };
};

export type ResolvedStripeTarget = {
  customer: StripeCustomer;
  subscription: StripeSubscription;
};

export type LocalContext = {
  clinicId: string;
  planId: string;
  billingInterval: BillingInterval | null;
};

function parseArgs(argv: string[]): Selector {
  const selector: Selector = { dryRun: false };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if (arg === '--dry-run') {
      selector.dryRun = true;
      continue;
    }

    if (!next || next.startsWith('--')) {
      throw new Error(`Valor ausente para ${arg}.`);
    }

    if (arg === '--email') selector.email = next.trim().toLowerCase();
    else if (arg === '--stripe-customer-id') selector.stripeCustomerId = next.trim();
    else if (arg === '--stripe-subscription-id') selector.stripeSubscriptionId = next.trim();
    else if (arg === '--clinic-id') selector.clinicId = next.trim();
    else throw new Error(`Argumento desconhecido: ${arg}`);

    index += 1;
  }

  const inputs = [
    selector.email,
    selector.stripeCustomerId,
    selector.stripeSubscriptionId,
    selector.clinicId,
  ].filter(Boolean);

  if (inputs.length !== 1) {
    throw new Error(
      'Informe exatamente um seletor: --email, --stripe-customer-id, --stripe-subscription-id ou --clinic-id.',
    );
  }

  return selector;
}

async function main() {
  const selector = parseArgs(process.argv.slice(2));

  if (!databaseConfig.url) {
    throw new Error('DATABASE_URL não configurada.');
  }

  if (!stripeConfig.secretKey) {
    throw new Error('STRIPE_SECRET_KEY não configurada.');
  }

  const pool = new Pool({ connectionString: databaseConfig.url });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  const stripe = new Stripe(stripeConfig.secretKey, {
    apiVersion: '2026-03-25.dahlia',
  });

  try {
    await prisma.$connect();
    const target = await resolveStripeTarget(stripe, prisma, selector);
    const local = await resolveLocalContext(prisma, selector, target);
    const before = await prisma.subscription.findUnique({
      where: { clinicId: local.clinicId },
      include: { plan: { select: { slug: true, name: true } } },
    });

    const afterData = buildSubscriptionData(target, local);

    printSummary('Antes', {
      clinicId: local.clinicId,
      planId: before?.planId ?? null,
      plan: before?.plan?.slug ?? null,
      status: before?.status ?? null,
      stripeCustomerId: before?.stripeCustomerId ?? null,
      stripeSubscriptionId: before?.stripeSubscriptionId ?? null,
      currentPeriodEnd: before?.currentPeriodEnd ?? null,
      access: before ? describeAccess(before.status, before.currentPeriodEnd, before.trialEndsAt) : 'BLOCKED',
    });

    printSummary(selector.dryRun ? 'Depois previsto' : 'Depois', {
      clinicId: local.clinicId,
      planId: local.planId,
      plan: await getPlanSlug(prisma, local.planId),
      status: afterData.status,
      stripeCustomerId: afterData.stripeCustomerId,
      stripeSubscriptionId: afterData.stripeSubscriptionId,
      currentPeriodEnd: afterData.currentPeriodEnd ?? null,
      access: describeAccess(
        afterData.status,
        afterData.currentPeriodEnd ?? null,
        afterData.trialEndsAt ?? null,
      ),
    });

    if (selector.dryRun) {
      console.log('\nDRY RUN: nenhum registro foi alterado.');
      return;
    }

    const saved = await prisma.subscription.upsert({
      where: { clinicId: local.clinicId },
      create: afterData,
      update: afterData,
    });

    await syncSubscriptionItems(prisma, saved.id, target.subscription.items.data);

    console.log(
      `\nSincronização concluída. subscriptionId=${saved.id} clinicId=${saved.clinicId} status=${saved.status}`,
    );
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

async function resolveStripeTarget(
  stripe: StripeConstructor.Stripe,
  prisma: PrismaClient,
  selector: Selector,
): Promise<ResolvedStripeTarget> {
  if (selector.stripeSubscriptionId) {
    const subscription = await retrieveSubscription(stripe, selector.stripeSubscriptionId);
    const customer = await retrieveCustomer(stripe, resolveId(subscription.customer));
    return { customer, subscription };
  }

  if (selector.stripeCustomerId) {
    const customer = await retrieveCustomer(stripe, selector.stripeCustomerId);
    return { customer, subscription: await pickLatestSubscription(stripe, customer.id) };
  }

  if (selector.clinicId) {
    const localSubscription = await prisma.subscription.findUnique({
      where: { clinicId: selector.clinicId },
      select: { stripeCustomerId: true, stripeSubscriptionId: true, clinic: { select: { email: true } } },
    });
    const localClinic = await prisma.clinic.findFirst({
      where: { id: selector.clinicId, isActive: true, deletedAt: null },
      select: { email: true },
    });

    if (localSubscription?.stripeSubscriptionId) {
      const subscription = await retrieveSubscription(stripe, localSubscription.stripeSubscriptionId);
      const customer = await retrieveCustomer(stripe, resolveId(subscription.customer));
      return { customer, subscription };
    }

    if (localSubscription?.stripeCustomerId) {
      const customer = await retrieveCustomer(stripe, localSubscription.stripeCustomerId);
      return { customer, subscription: await pickLatestSubscription(stripe, customer.id) };
    }

    const clinicEmail = localSubscription?.clinic.email ?? localClinic?.email;
    if (clinicEmail) {
      return resolveByEmail(stripe, clinicEmail);
    }

    throw new Error(
      'A clínica não possui IDs Stripe locais nem e-mail de cobrança para reconciliação.',
    );
  }

  if (selector.email) {
    return resolveByEmail(stripe, selector.email);
  }

  throw new Error('Seletor inválido.');
}

async function resolveByEmail(
  stripe: StripeConstructor.Stripe,
  email: string,
): Promise<ResolvedStripeTarget> {
  const customers = await stripe.customers.list({ email, limit: 10 });
  const activeCustomers = customers.data.filter(
    (customer) => !('deleted' in customer && customer.deleted),
  );

  const candidates: ResolvedStripeTarget[] = [];
  for (const customer of activeCustomers) {
    try {
      const subscription = await pickLatestSubscription(stripe, customer.id);
      candidates.push({ customer, subscription });
    } catch {
      // Customer without subscriptions is not useful for this reconciliation.
    }
  }

  if (candidates.length === 0) {
    throw new Error(`Nenhuma assinatura Stripe encontrada para o e-mail ${maskEmail(email)}.`);
  }

  return pickBestCandidate(candidates);
}

async function retrieveSubscription(
  stripe: StripeConstructor.Stripe,
  subscriptionId: string,
): Promise<StripeSubscription> {
  const subscription = (await stripe.subscriptions.retrieve(
    subscriptionId,
  )) as StripeSubscription;
  if (subscription.status === 'incomplete_expired') {
    console.warn('Aviso: assinatura Stripe está incomplete_expired e não libera acesso.');
  }
  return subscription;
}

async function retrieveCustomer(
  stripe: StripeConstructor.Stripe,
  customerId: string | null,
): Promise<StripeCustomer> {
  if (!customerId) throw new Error('Assinatura Stripe sem customer id.');
  const customer = await stripe.customers.retrieve(customerId);
  if ('deleted' in customer && customer.deleted) {
    throw new Error('Cliente Stripe está deletado.');
  }
  return customer as StripeCustomer;
}

async function pickLatestSubscription(
  stripe: StripeConstructor.Stripe,
  customerId: string,
): Promise<StripeSubscription> {
  const subscriptions = await stripe.subscriptions.list({
    customer: customerId,
    status: 'all',
    limit: 100,
  });

  if (subscriptions.data.length === 0) {
    throw new Error(`Cliente ${maskStripeId(customerId)} não possui assinaturas Stripe.`);
  }

  return pickBestCandidate(
    subscriptions.data.map((subscription) => ({
      customer: { id: customerId } as StripeCustomer,
      subscription: subscription as StripeSubscription,
    })),
  ).subscription;
}

function pickBestCandidate(candidates: ResolvedStripeTarget[]): ResolvedStripeTarget {
  const priority: Record<string, number> = {
    active: 5,
    trialing: 4,
    past_due: 3,
    incomplete: 2,
    unpaid: 1,
    paused: 1,
    canceled: 0,
    incomplete_expired: 0,
  };

  return [...candidates].sort((a, b) => {
    const byPriority =
      (priority[b.subscription.status] ?? 0) - (priority[a.subscription.status] ?? 0);
    if (byPriority !== 0) return byPriority;
    return b.subscription.created - a.subscription.created;
  })[0];
}

async function resolveLocalContext(
  prisma: PrismaClient,
  selector: Selector,
  target: ResolvedStripeTarget,
): Promise<LocalContext> {
  const stripeCustomerId = target.customer.id;
  const stripeSubscriptionId = target.subscription.id;
  const metadataClinicId =
    target.subscription.metadata?.clinicId || target.customer.metadata?.clinicId || null;
  const metadataPlanId = target.subscription.metadata?.planId || null;
  const firstItem = target.subscription.items.data[0];
  const priceId = firstItem?.price.id ?? null;

  const existingBySubscription = await prisma.subscription.findUnique({
    where: { stripeSubscriptionId },
    select: { clinicId: true, planId: true },
  });
  const existingByCustomer = await prisma.subscription.findUnique({
    where: { stripeCustomerId },
    select: { clinicId: true, planId: true },
  });
  const existingByClinic = selector.clinicId
    ? await prisma.subscription.findUnique({
        where: { clinicId: selector.clinicId },
        select: { clinicId: true, planId: true, stripeCustomerId: true, stripeSubscriptionId: true },
      })
    : null;

  const clinicIds = uniqueValues([
    selector.clinicId,
    metadataClinicId,
    existingBySubscription?.clinicId,
    existingByCustomer?.clinicId,
    existingByClinic?.clinicId,
  ]);

  if (selector.email && clinicIds.length === 0) {
    const users = await prisma.user.findMany({
      where: { email: selector.email, isActive: true, deletedAt: null },
      select: { clinicId: true },
    });
    const clinics = await prisma.clinic.findMany({
      where: { email: selector.email, isActive: true, deletedAt: null },
      select: { id: true },
    });
    clinicIds.push(...uniqueValues(users.map((user) => user.clinicId ?? undefined)));
    clinicIds.push(...uniqueValues(clinics.map((clinic) => clinic.id)));
  }

  const uniqueClinicIds = uniqueValues(clinicIds);
  if (uniqueClinicIds.length !== 1) {
    throw new Error(
      `Não foi possível validar uma única clínica para esta assinatura. Use --clinic-id ou --stripe-subscription-id. clinicIds=${uniqueClinicIds.join(',') || 'nenhum'}`,
    );
  }

  const clinicId = uniqueClinicIds[0];
  const clinic = await prisma.clinic.findFirst({
    where: { id: clinicId, isActive: true, deletedAt: null },
    select: { id: true },
  });

  if (!clinic) {
    throw new Error('Clínica local não encontrada, inativa ou removida.');
  }

  if (existingByClinic?.stripeCustomerId && existingByClinic.stripeCustomerId !== stripeCustomerId) {
    throw new Error(
      'A clínica já possui outro stripeCustomerId local. Interrompido para revisão manual.',
    );
  }

  if (
    existingByClinic?.stripeSubscriptionId &&
    existingByClinic.stripeSubscriptionId !== stripeSubscriptionId
  ) {
    const currentStatus = mapStripeSubscriptionStatus(target.subscription.status);
    if (
      currentStatus !== SubscriptionStatus.ACTIVE &&
      currentStatus !== SubscriptionStatus.TRIALING
    ) {
      throw new Error(
        'A clínica já possui outra assinatura local e a assinatura Stripe selecionada não está ativa/trialing.',
      );
    }
  }

  const plan = await resolvePlan(prisma, metadataPlanId, priceId);
  const billingInterval =
    firstItem?.price.recurring?.interval != null
      ? mapStripePriceInterval(firstItem.price.recurring.interval)
      : resolveIntervalFromPlan(plan, priceId);

  return { clinicId, planId: plan.id, billingInterval };
}

async function resolvePlan(
  prisma: PrismaClient,
  metadataPlanId: string | null,
  priceId: string | null,
) {
  if (!metadataPlanId && !priceId) {
    throw new Error('Assinatura Stripe sem planId em metadata e sem priceId no item.');
  }

  const plan = await prisma.plan.findFirst({
    where: {
      isActive: true,
      OR: [
        ...(metadataPlanId ? [{ id: metadataPlanId }] : []),
        ...(priceId
          ? [{ stripePriceIdMonthly: priceId }, { stripePriceIdYearly: priceId }]
          : []),
      ],
    },
  });

  if (!plan) {
    throw new Error(
      `Plano local não encontrado para priceId=${maskStripeId(priceId)} metadataPlanId=${metadataPlanId ?? 'ausente'}.`,
    );
  }

  return plan;
}

function resolveIntervalFromPlan(
  plan: { stripePriceIdMonthly: string | null; stripePriceIdYearly: string | null },
  priceId: string | null,
): BillingInterval | null {
  if (!priceId) return null;
  if (plan.stripePriceIdMonthly === priceId) return BillingInterval.MONTHLY;
  if (plan.stripePriceIdYearly === priceId) return BillingInterval.YEARLY;
  return null;
}

export function buildSubscriptionData(
  target: ResolvedStripeTarget,
  local: LocalContext,
) {
  const stripeSubscription = target.subscription;
  const firstItem = stripeSubscription.items.data[0];

  return {
    clinicId: local.clinicId,
    planId: local.planId,
    stripeCustomerId: target.customer.id,
    stripeSubscriptionId: stripeSubscription.id,
    billingInterval: local.billingInterval,
    status: mapStripeSubscriptionStatus(stripeSubscription.status),
    currentPeriodStart: firstItem
      ? new Date(firstItem.current_period_start * 1000)
      : null,
    currentPeriodEnd: firstItem ? new Date(firstItem.current_period_end * 1000) : null,
    trialEndsAt: stripeSubscription.trial_end
      ? new Date(stripeSubscription.trial_end * 1000)
      : null,
    cancelAtPeriodEnd: hasScheduledCancellation(stripeSubscription),
    canceledAt: stripeSubscription.canceled_at
      ? new Date(stripeSubscription.canceled_at * 1000)
      : null,
    endedAt: stripeSubscription.ended_at ? new Date(stripeSubscription.ended_at * 1000) : null,
  };
}

async function syncSubscriptionItems(
  prisma: PrismaClient,
  subscriptionId: string,
  items: StripeSubscriptionItem[],
) {
  for (const item of items) {
    const price = item.price;
    await prisma.subscriptionItem.upsert({
      where: { stripeSubscriptionItemId: item.id },
      create: {
        subscriptionId,
        stripeSubscriptionItemId: item.id,
        stripePriceId: price.id,
        priceNickname: price.nickname,
        billingInterval: mapStripePriceInterval(price.recurring?.interval),
        unitAmount: price.unit_amount,
        unitAmountDecimal: price.unit_amount_decimal
          ? String(price.unit_amount_decimal)
          : null,
        currency: price.currency.toUpperCase(),
        quantity: item.quantity ?? 1,
      },
      update: {
        subscriptionId,
        stripePriceId: price.id,
        priceNickname: price.nickname,
        billingInterval: mapStripePriceInterval(price.recurring?.interval),
        unitAmount: price.unit_amount,
        unitAmountDecimal: price.unit_amount_decimal
          ? String(price.unit_amount_decimal)
          : null,
        currency: price.currency.toUpperCase(),
        quantity: item.quantity ?? 1,
      },
    });
  }
}

async function getPlanSlug(prisma: PrismaClient, planId: string) {
  const plan = await prisma.plan.findUnique({
    where: { id: planId },
    select: { slug: true },
  });
  return plan?.slug ?? null;
}

function describeAccess(
  status: SubscriptionStatus,
  currentPeriodEnd: Date | null,
  trialEndsAt: Date | null,
) {
  const now = Date.now();

  if (status === SubscriptionStatus.ACTIVE) return 'ALLOWED';
  if (status === SubscriptionStatus.TRIALING && trialEndsAt && trialEndsAt.getTime() > now) {
    return 'ALLOWED';
  }
  if (
    status === SubscriptionStatus.CANCELED &&
    currentPeriodEnd &&
    currentPeriodEnd.getTime() > now
  ) {
    return 'ALLOWED_UNTIL_PERIOD_END';
  }

  return 'BLOCKED';
}

function printSummary(
  title: string,
  data: {
    clinicId: string;
    planId: string | null;
    plan: string | null;
    status: SubscriptionStatus | null;
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    currentPeriodEnd: Date | null;
    access: string;
  },
) {
  console.log(`\n${title}`);
  console.log(`clinicId: ${data.clinicId}`);
  console.log(`planId: ${data.planId ?? 'ausente'}`);
  console.log(`plan: ${data.plan ?? 'ausente'}`);
  console.log(`status: ${data.status ?? 'ausente'}`);
  console.log(`stripeCustomerId: ${maskStripeId(data.stripeCustomerId)}`);
  console.log(`stripeSubscriptionId: ${maskStripeId(data.stripeSubscriptionId)}`);
  console.log(`currentPeriodEnd: ${data.currentPeriodEnd?.toISOString() ?? 'ausente'}`);
  console.log(`access: ${data.access}`);
}

function resolveId(field: string | { id: string } | null | undefined): string | null {
  if (!field) return null;
  return typeof field === 'string' ? field : field.id;
}

function uniqueValues(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!domain) return '***';
  return `${user.slice(0, 2)}***@${domain}`;
}

function maskStripeId(value: string | null): string {
  if (!value) return 'ausente';
  if (value.length <= 12) return `${value.slice(0, 4)}...`;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\nFalha na reconciliação: ${message}`);
    process.exitCode = 1;
  });
}
