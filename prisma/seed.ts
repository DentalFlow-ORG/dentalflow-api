import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const SPECIALTIES: { name: string; slug: string }[] = [
  { name: 'Clínica Geral', slug: 'clinica-geral' },
  { name: 'Ortodontia', slug: 'ortodontia' },
  { name: 'Endodontia', slug: 'endodontia' },
  { name: 'Periodontia', slug: 'periodontia' },
  { name: 'Implantodontia', slug: 'implantodontia' },
  { name: 'Cirurgia Bucomaxilofacial', slug: 'cirurgia-bucomaxilofacial' },
  { name: 'Odontopediatria', slug: 'odontopediatria' },
  { name: 'Prótese Dentária', slug: 'protese-dentaria' },
  { name: 'Dentística', slug: 'dentistica' },
  { name: 'Radiologia Odontológica', slug: 'radiologia-odontologica' },
  { name: 'Estomatologia', slug: 'estomatologia' },
  { name: 'Patologia Oral', slug: 'patologia-oral' },
  { name: 'Odontogeriatria', slug: 'odontogeriatria' },
  { name: 'Odontologia do Esporte', slug: 'odontologia-do-esporte' },
  { name: 'Odontologia Legal', slug: 'odontologia-legal' },
  { name: 'Odontologia do Trabalho', slug: 'odontologia-do-trabalho' },
  { name: 'Saúde Coletiva em Odontologia', slug: 'saude-coletiva' },
  { name: 'Harmonização Orofacial', slug: 'harmonizacao-orofacial' },
  {
    name: 'Disfunção Temporomandibular e Dor Orofacial',
    slug: 'disfuncao-temporomandibular',
  },
  { name: 'Administração Odontológica', slug: 'administracao-odontologica' },
];

interface PlanSeed {
  name: string;
  slug: string;
  description: string;
  priceMonthly: number;
  priceYearly: number;
  stripePriceIdMonthly: string | null;
  stripePriceIdYearly: string | null;
  maxUsersPerClinic: number;
  maxProfiles: number | null;
  maxServicesPerProfile: number | null;
  hasAppointments: boolean;
  hasAnalytics: boolean;
  hasCustomDomain: boolean;
  hasPrioritySupport: boolean;
  isPublic: boolean;
  displayOrder: number;
}

// Slugs that were replaced by the current plan lineup.
// Marked inactive so they are hidden from the frontend without deleting the
// rows (existing Subscription FK references are preserved).
const LEGACY_PLAN_SLUGS = ['basic', 'pro', 'enterprise'];

// PLAN LIMITS — ACTIVE
// maxProfiles / maxServicesPerProfile: not yet enforced — kept null.
// Re-run `pnpm prisma db seed` to apply changes to a fresh environment.
// For existing production databases, apply via the operational SQL in docs.
const PLANS: PlanSeed[] = [
  {
    name: 'Starter',
    slug: 'starter',
    description:
      'Ideal para dentistas autônomos que querem começar a captar pacientes online.',
    priceMonthly: 12990,
    priceYearly: 129900,
    stripePriceIdMonthly: 'price_1TTQseEpOLGVHpKlyaPh1zWt',
    stripePriceIdYearly: 'price_1TTQtnEpOLGVHpKlFKmFyH4V',
    maxUsersPerClinic: 8,
    maxProfiles: null,
    maxServicesPerProfile: null,
    hasAppointments: true,
    hasAnalytics: true,
    hasCustomDomain: true,
    hasPrioritySupport: true,
    isPublic: true,
    displayOrder: 1,
  },
  {
    name: 'Professional',
    slug: 'professional',
    description:
      'Para clínicas em crescimento que precisam de agendamento e métricas completas.',
    priceMonthly: 21990,
    priceYearly: 219900,
    stripePriceIdMonthly: 'price_1TTQt0EpOLGVHpKln1zcaZYX',
    stripePriceIdYearly: 'price_1TTQu4EpOLGVHpKlwwzZWUOh',
    maxUsersPerClinic: 16,
    maxProfiles: null,
    maxServicesPerProfile: null,
    hasAppointments: true,
    hasAnalytics: true,
    hasCustomDomain: true,
    hasPrioritySupport: true,
    isPublic: true,
    displayOrder: 2,
  },
  {
    name: 'Premium',
    slug: 'premium',
    description:
      'Para grandes clínicas e redes odontológicas com múltiplos profissionais.',
    priceMonthly: 29990,
    priceYearly: 299900,
    stripePriceIdMonthly: 'price_1TTQtIEpOLGVHpKlwHHqMQEa',
    stripePriceIdYearly: 'price_1TTQuJEpOLGVHpKlCDg8dROV',
    maxUsersPerClinic: 24,
    maxProfiles: null,
    maxServicesPerProfile: null,
    hasAppointments: true,
    hasAnalytics: true,
    hasCustomDomain: true,
    hasPrioritySupport: true,
    isPublic: true,
    displayOrder: 3,
  },
];

const SEED_PASSWORD = process.env.SEED_USER_PASSWORD ?? 'DentalFlow@123';
const BCRYPT_ROUNDS = 12;

async function seed(prisma: PrismaClient): Promise<void> {
  console.log('Seeding specialties...');
  for (const specialty of SPECIALTIES) {
    await prisma.specialty.upsert({
      where: { slug: specialty.slug },
      update: { name: specialty.name },
      create: specialty,
    });
  }
  console.log(`  - ${SPECIALTIES.length} specialties upserted`);

  console.log('Seeding plans...');
  if (LEGACY_PLAN_SLUGS.length > 0) {
    await prisma.plan.updateMany({
      where: { slug: { in: LEGACY_PLAN_SLUGS } },
      data: { isActive: false, isPublic: false },
    });
    console.log(`  - ${LEGACY_PLAN_SLUGS.length} legacy plans deactivated`);
  }
  for (const plan of PLANS) {
    await prisma.plan.upsert({
      where: { slug: plan.slug },
      update: {
        name: plan.name,
        description: plan.description,
        priceMonthly: plan.priceMonthly,
        priceYearly: plan.priceYearly,
        stripePriceIdMonthly: plan.stripePriceIdMonthly,
        stripePriceIdYearly: plan.stripePriceIdYearly,
        maxUsersPerClinic: plan.maxUsersPerClinic,
        maxProfiles: plan.maxProfiles,
        maxServicesPerProfile: plan.maxServicesPerProfile,
        hasAppointments: plan.hasAppointments,
        hasAnalytics: plan.hasAnalytics,
        hasCustomDomain: plan.hasCustomDomain,
        hasPrioritySupport: plan.hasPrioritySupport,
        isPublic: plan.isPublic,
        displayOrder: plan.displayOrder,
      },
      create: plan,
    });
  }
  console.log(`  - ${PLANS.length} plans upserted`);

  console.log('Seeding role users...');
  const passwordHash = await bcrypt.hash(SEED_PASSWORD, BCRYPT_ROUNDS);

  const clinic = await prisma.clinic.upsert({
    where: { id: 'seed-clinic-dentalflow' },
    update: {
      name: 'Clínica DentalFlow',
      email: 'clinica.demo@dentalflow.local',
      city: 'São Paulo',
      state: 'SP',
    },
    create: {
      id: 'seed-clinic-dentalflow',
      name: 'Clínica DentalFlow',
      email: 'clinica.demo@dentalflow.local',
      city: 'São Paulo',
      state: 'SP',
    },
  });

  await prisma.user.upsert({
    where: { email: 'admin@dentalflow.local' },
    update: {
      clinicId: null,
      firstName: 'Admin',
      lastName: 'DentalFlow',
      role: 'ADMIN',
      isActive: true,
    },
    create: {
      clinicId: null,
      email: 'admin@dentalflow.local',
      passwordHash,
      firstName: 'Admin',
      lastName: 'DentalFlow',
      role: 'ADMIN',
    },
  });

  await prisma.user.upsert({
    where: { email: 'owner@dentalflow.local' },
    update: {
      clinicId: clinic.id,
      firstName: 'Olivia',
      lastName: 'Owner',
      role: 'OWNER',
      isActive: true,
    },
    create: {
      clinicId: clinic.id,
      email: 'owner@dentalflow.local',
      passwordHash,
      firstName: 'Olivia',
      lastName: 'Owner',
      role: 'OWNER',
    },
  });

  const dentist = await prisma.user.upsert({
    where: { email: 'dentist@dentalflow.local' },
    update: {
      clinicId: clinic.id,
      firstName: 'Daniel',
      lastName: 'Dentista',
      role: 'DENTIST',
      isActive: true,
    },
    create: {
      clinicId: clinic.id,
      email: 'dentist@dentalflow.local',
      passwordHash,
      firstName: 'Daniel',
      lastName: 'Dentista',
      role: 'DENTIST',
    },
  });

  await prisma.user.upsert({
    where: { email: 'assistant@dentalflow.local' },
    update: {
      clinicId: clinic.id,
      firstName: 'Amanda',
      lastName: 'Assistente',
      role: 'ASSISTANT',
      isActive: true,
    },
    create: {
      clinicId: clinic.id,
      email: 'assistant@dentalflow.local',
      passwordHash,
      firstName: 'Amanda',
      lastName: 'Assistente',
      role: 'ASSISTANT',
    },
  });

  await prisma.user.upsert({
    where: { email: 'patient@dentalflow.local' },
    update: {
      clinicId: null,
      firstName: 'Paula',
      lastName: 'Paciente',
      role: 'PATIENT',
      isActive: true,
    },
    create: {
      clinicId: null,
      email: 'patient@dentalflow.local',
      passwordHash,
      firstName: 'Paula',
      lastName: 'Paciente',
      role: 'PATIENT',
    },
  });

  await prisma.profile.upsert({
    where: { slug: 'dr-daniel-dentista' },
    update: {
      clinicId: clinic.id,
      userId: dentist.id,
      displayName: 'Dr. Daniel Dentista',
      isPublished: true,
      city: 'São Paulo',
      state: 'SP',
    },
    create: {
      clinicId: clinic.id,
      userId: dentist.id,
      slug: 'dr-daniel-dentista',
      displayName: 'Dr. Daniel Dentista',
      bio: 'Atendimento odontológico integrado para pacientes da Clínica DentalFlow.',
      crmNumber: '12345',
      crmState: 'SP',
      city: 'São Paulo',
      state: 'SP',
      isPublished: true,
    },
  });

  console.log('  - role users upserted');

  console.log('Seeding notification templates...');
  const NOTIFICATION_TEMPLATES = [
    {
      slug: 'appointment_reminder_24h',
      channel: 'WHATSAPP' as const,
      category: 'UTILITY' as const,
      bodyPt:
        'Olá, {{1}}! Lembramos que você tem uma consulta agendada para amanhã, {{2}} às {{3}}, na {{4}}. Aguardamos você!',
      variables: ['patientName', 'date', 'time', 'clinicName'],
      isActive: true,
    },
    {
      slug: 'appointment_confirmation_request',
      channel: 'WHATSAPP' as const,
      category: 'UTILITY' as const,
      bodyPt:
        'Olá, {{1}}! Confirme sua consulta em {{2}} às {{3}} na {{4}} respondendo SIM para confirmar ou NÃO para cancelar.',
      variables: ['patientName', 'date', 'time', 'clinicName'],
      isActive: true,
    },
    {
      slug: 'appointment_rescheduled',
      channel: 'WHATSAPP' as const,
      category: 'UTILITY' as const,
      bodyPt:
        'Olá, {{1}}! Sua consulta foi reagendada para {{2}} às {{3}} na {{4}}. Em caso de dúvidas, entre em contato conosco.',
      variables: ['patientName', 'date', 'time', 'clinicName'],
      isActive: true,
    },
    {
      slug: 'payment_pending_notice',
      channel: 'WHATSAPP' as const,
      category: 'UTILITY' as const,
      bodyPt:
        'Olá, {{1}}! Informamos que há um valor pendente de {{2}} na {{4}}. Entre em contato para regularizar.',
      variables: ['patientName', 'amount', 'clinicName'],
      isActive: true,
    },
    {
      slug: 'post_appointment_simple',
      channel: 'WHATSAPP' as const,
      category: 'UTILITY' as const,
      bodyPt:
        'Olá, {{1}}! Obrigado pela sua visita à {{4}}. Esperamos que tenha gostado do atendimento. Estamos sempre à disposição!',
      variables: ['patientName', 'clinicName'],
      isActive: true,
    },
  ];

  for (const tpl of NOTIFICATION_TEMPLATES) {
    await prisma.notificationTemplate.upsert({
      where: { slug: tpl.slug },
      update: { bodyPt: tpl.bodyPt, variables: tpl.variables, isActive: tpl.isActive },
      create: tpl,
    });
  }
  console.log(`  - ${NOTIFICATION_TEMPLATES.length} notification templates upserted`);
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  try {
    await seed(prisma);
    console.log('Seed completed successfully.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
