import type { AppointmentStatus, PrismaClient, UserRole } from '@prisma/client';
import * as bcrypt from 'bcrypt';

/**
 * Deterministic factories for the integration suite.
 *
 * Every value is explicit and stable — no randomness, no "faker" — so a
 * failure reproduces exactly and an assertion can name the value it expects.
 * Ids are caller-supplied for the same reason: a test that asserts on
 * `clinic-a` reads better than one that threads a generated cuid around.
 *
 * These write through the real client, so they also exercise the schema's
 * required fields and defaults; a factory that stops compiling or inserting is
 * itself a signal that the schema changed.
 */

export const TEST_PASSWORD = 'Str0ngPassw0rd!';

/** Hashing is slow by design; the integration suite needs one hash, not fifty. */
let cachedPasswordHash: string | null = null;
export async function testPasswordHash(): Promise<string> {
  cachedPasswordHash ??= await bcrypt.hash(TEST_PASSWORD, 10);
  return cachedPasswordHash;
}

export async function createClinic(
  prisma: PrismaClient,
  overrides: {
    id?: string;
    name?: string;
    email?: string;
    deletedAt?: Date | null;
  } = {},
) {
  return prisma.clinic.create({
    data: {
      id: overrides.id ?? 'clinic-a',
      name: overrides.name ?? 'Clínica Alpha',
      email: overrides.email ?? `${overrides.id ?? 'clinic-a'}@example.test`,
      deletedAt: overrides.deletedAt ?? null,
    },
  });
}

export async function createUser(
  prisma: PrismaClient,
  overrides: {
    id?: string;
    clinicId?: string | null;
    role?: UserRole;
    email?: string;
    firstName?: string;
    lastName?: string;
    isActive?: boolean;
    deletedAt?: Date | null;
    tokenVersion?: number;
  } = {},
) {
  const id = overrides.id ?? 'user-a';
  return prisma.user.create({
    data: {
      id,
      clinicId:
        overrides.clinicId === undefined ? 'clinic-a' : overrides.clinicId,
      email: overrides.email ?? `${id}@example.test`,
      passwordHash: await testPasswordHash(),
      firstName: overrides.firstName ?? 'Ana',
      lastName: overrides.lastName ?? 'Souza',
      role: overrides.role ?? 'OWNER',
      isActive: overrides.isActive ?? true,
      deletedAt: overrides.deletedAt ?? null,
      tokenVersion: overrides.tokenVersion ?? 0,
    },
  });
}

export async function createProfile(
  prisma: PrismaClient,
  overrides: {
    id?: string;
    clinicId?: string;
    userId?: string | null;
    displayName?: string;
    slug?: string;
    isPublished?: boolean;
  } = {},
) {
  const id = overrides.id ?? 'profile-a';
  return prisma.profile.create({
    data: {
      id,
      clinicId: overrides.clinicId ?? 'clinic-a',
      userId: overrides.userId === undefined ? null : overrides.userId,
      displayName: overrides.displayName ?? 'Dra. Ana Souza',
      slug: overrides.slug ?? id,
      isPublished: overrides.isPublished ?? false,
    },
  });
}

/** `appointmentDate` is stored at UTC midnight; times carry only hh:mm. */
export function utcDate(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}
export function utcTime(hhmm: string): Date {
  return new Date(`1970-01-01T${hhmm}:00.000Z`);
}

export async function createAppointment(
  prisma: PrismaClient,
  overrides: {
    id?: string;
    clinicId?: string;
    profileId?: string;
    status?: AppointmentStatus;
    appointmentDate?: Date;
    startTime?: Date;
    endTime?: Date;
    patientName?: string;
    patientEmail?: string | null;
    durationMinutes?: number;
  } = {},
) {
  const id = overrides.id ?? 'appointment-a';
  return prisma.appointment.create({
    data: {
      id,
      clinicId: overrides.clinicId ?? 'clinic-a',
      profileId: overrides.profileId ?? 'profile-a',
      status: overrides.status ?? 'PENDING',
      appointmentDate: overrides.appointmentDate ?? utcDate('2026-06-15'),
      startTime: overrides.startTime ?? utcTime('09:00'),
      endTime: overrides.endTime ?? utcTime('10:00'),
      durationMinutes: overrides.durationMinutes ?? 60,
      patientName: overrides.patientName ?? 'Maria Silva',
      patientEmail:
        overrides.patientEmail === undefined
          ? 'maria@example.test'
          : overrides.patientEmail,
    },
  });
}

export async function createFinancialCategory(
  prisma: PrismaClient,
  overrides: {
    id?: string;
    clinicId?: string;
    name?: string;
    type?: 'INCOME' | 'EXPENSE';
  } = {},
) {
  const id = overrides.id ?? 'category-a';
  return prisma.financialCategory.create({
    data: {
      id,
      clinicId: overrides.clinicId ?? 'clinic-a',
      name: overrides.name ?? 'Serviços',
      type: overrides.type ?? 'INCOME',
    },
  });
}

export async function createTransaction(
  prisma: PrismaClient,
  overrides: {
    id?: string;
    clinicId?: string;
    categoryId?: string;
    createdByUserId?: string;
    type?: 'INCOME' | 'EXPENSE';
    status?: 'PENDING' | 'PAID' | 'CANCELED';
    amount?: number;
    description?: string;
    transactionDate?: Date;
  } = {},
) {
  const id = overrides.id ?? 'transaction-a';
  return prisma.financialTransaction.create({
    data: {
      id,
      clinicId: overrides.clinicId ?? 'clinic-a',
      categoryId: overrides.categoryId ?? 'category-a',
      createdByUserId: overrides.createdByUserId ?? 'owner-a',
      type: overrides.type ?? 'INCOME',
      status: overrides.status ?? 'PAID',
      amount: overrides.amount ?? 100,
      description: overrides.description ?? 'Consulta',
      transactionDate: overrides.transactionDate ?? utcDate('2026-06-10'),
    },
  });
}

export async function createStockProduct(
  prisma: PrismaClient,
  overrides: {
    id?: string;
    clinicId?: string;
    categoryId?: string;
    name?: string;
    currentQuantity?: number;
    minQuantity?: number;
    isActive?: boolean;
  } = {},
) {
  const id = overrides.id ?? 'product-a';
  return prisma.stockProduct.create({
    data: {
      id,
      clinicId: overrides.clinicId ?? 'clinic-a',
      categoryId: overrides.categoryId ?? 'stock-category-a',
      name: overrides.name ?? 'Luva de procedimento',
      unit: 'CX',
      currentQuantity: overrides.currentQuantity ?? 100,
      minQuantity: overrides.minQuantity ?? 10,
      isActive: overrides.isActive ?? true,
    },
  });
}

export async function createStockCategory(
  prisma: PrismaClient,
  overrides: { id?: string; clinicId?: string; name?: string } = {},
) {
  const id = overrides.id ?? 'stock-category-a';
  return prisma.stockCategory.create({
    data: {
      id,
      clinicId: overrides.clinicId ?? 'clinic-a',
      name: overrides.name ?? 'Descartáveis',
    },
  });
}

export async function createInvoice(
  prisma: PrismaClient,
  overrides: {
    id?: string;
    clinicId?: string;
    createdByUserId?: string;
    status?:
      | 'DRAFT'
      | 'READY_TO_ISSUE'
      | 'SIMULATED'
      | 'PROCESSING'
      | 'ISSUED'
      | 'FAILED'
      | 'CANCELED';
    customerName?: string;
    amountCents?: number;
    competenceDate?: Date;
    appointmentId?: string | null;
    patientId?: string | null;
  } = {},
) {
  const id = overrides.id ?? 'invoice-a';
  return prisma.serviceInvoice.create({
    data: {
      id,
      clinicId: overrides.clinicId ?? 'clinic-a',
      createdByUserId: overrides.createdByUserId ?? 'owner-a',
      status: overrides.status ?? 'DRAFT',
      customerName: overrides.customerName ?? 'Maria Silva',
      serviceDescription: 'Limpeza dental',
      amountCents: overrides.amountCents ?? 20000,
      competenceDate: overrides.competenceDate ?? utcDate('2026-06-10'),
      appointmentId: overrides.appointmentId ?? null,
      patientId: overrides.patientId ?? null,
    },
  });
}

/**
 * A plan with every capability switched on.
 *
 * Integration tests are about persistence and tenancy, not plan tiering — which
 * has its own unit coverage — so the seeded plan grants everything. Gating is
 * still genuinely enforced: `BillingAccessGuard` and `PlanFeatureGuard` run
 * against these real rows, and a clinic without a subscription really does get
 * 402, as `subscribeClinic` being required to reach any endpoint demonstrates.
 */
export async function createPlan(
  prisma: PrismaClient,
  overrides: {
    id?: string;
    slug?: string;
    name?: string;
    isActive?: boolean;
    isPublic?: boolean;
  } = {},
) {
  // Derived from the slug so several plans can coexist in one test; a
  // no-argument call still yields `plan-full`, which seedTwoClinics and
  // subscribeClinic rely on.
  const id = overrides.id ?? `plan-${overrides.slug ?? 'full'}`;
  return prisma.plan.create({
    data: {
      id,
      name: overrides.name ?? 'Premium',
      slug: overrides.slug ?? 'premium',
      isActive: overrides.isActive ?? true,
      isPublic: overrides.isPublic ?? true,
      priceMonthly: 19900,
      priceYearly: 199000,
      maxUsersPerClinic: 50,
      maxProfiles: null,
      maxServicesPerProfile: null,
      hasAppointments: true,
      hasAnalytics: true,
      hasCustomDomain: true,
      hasPrioritySupport: true,
      hasWhatsApp: true,
      whatsappMonthlyLimit: 300,
      whatsappAutoReminder: true,
    },
  });
}

/** Gives a clinic an ACTIVE subscription so billing-gated routes are reachable. */
export async function subscribeClinic(
  prisma: PrismaClient,
  clinicId: string,
  overrides: {
    planId?: string;
    status?: 'ACTIVE' | 'TRIALING' | 'PAST_DUE' | 'CANCELED';
  } = {},
) {
  return prisma.subscription.create({
    data: {
      clinicId,
      planId: overrides.planId ?? 'plan-full',
      status: overrides.status ?? 'ACTIVE',
      billingInterval: 'MONTHLY',
      currentPeriodStart: utcDate('2026-06-01'),
      currentPeriodEnd: utcDate('2026-07-01'),
    },
  });
}

/**
 * Two complete clinics, each with an owner, a dentist and their profile.
 * The shape every tenant-isolation test starts from.
 */
export async function seedTwoClinics(prisma: PrismaClient) {
  await createClinic(prisma, { id: 'clinic-a', name: 'Clínica Alpha' });
  await createClinic(prisma, { id: 'clinic-b', name: 'Clínica Beta' });

  // Both clinics are subscribed: the billing guard is real here, and without a
  // subscription every clinic-data route answers 402 before the handler runs.
  await createPlan(prisma);
  await subscribeClinic(prisma, 'clinic-a');
  await subscribeClinic(prisma, 'clinic-b');

  const ownerA = await createUser(prisma, {
    id: 'owner-a',
    clinicId: 'clinic-a',
    role: 'OWNER',
  });
  const ownerB = await createUser(prisma, {
    id: 'owner-b',
    clinicId: 'clinic-b',
    role: 'OWNER',
  });
  const dentistA = await createUser(prisma, {
    id: 'dentist-a',
    clinicId: 'clinic-a',
    role: 'DENTIST',
  });
  const dentistB = await createUser(prisma, {
    id: 'dentist-b',
    clinicId: 'clinic-b',
    role: 'DENTIST',
  });
  const admin = await createUser(prisma, {
    id: 'platform-admin',
    clinicId: null,
    role: 'ADMIN',
  });

  const profileA = await createProfile(prisma, {
    id: 'profile-a',
    clinicId: 'clinic-a',
    userId: 'dentist-a',
    slug: 'dra-ana-alpha',
  });
  const profileB = await createProfile(prisma, {
    id: 'profile-b',
    clinicId: 'clinic-b',
    userId: 'dentist-b',
    slug: 'dr-bruno-beta',
  });

  return { ownerA, ownerB, dentistA, dentistB, admin, profileA, profileB };
}
