import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

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
  { name: 'Disfunção Temporomandibular e Dor Orofacial', slug: 'disfuncao-temporomandibular' },
  { name: 'Administração Odontológica', slug: 'administracao-odontologica' },
];

interface PlanSeed {
  name: string;
  slug: string;
  description: string;
  priceMonthly: number;
  priceYearly: number;
  maxProfiles: number | null;
  maxLeadsPerMonth: number | null;
  maxServicesPerProfile: number | null;
  hasAppointments: boolean;
  hasAnalytics: boolean;
  hasCustomDomain: boolean;
  hasPrioritySupport: boolean;
  isPublic: boolean;
  displayOrder: number;
}

const PLANS: PlanSeed[] = [
  {
    name: 'Basic',
    slug: 'basic',
    description: 'Ideal para dentistas autônomos que querem começar a captar pacientes online.',
    priceMonthly: 0,
    priceYearly: 0,
    maxProfiles: 1,
    maxLeadsPerMonth: 50,
    maxServicesPerProfile: 5,
    hasAppointments: false,
    hasAnalytics: false,
    hasCustomDomain: false,
    hasPrioritySupport: false,
    isPublic: true,
    displayOrder: 1,
  },
  {
    name: 'Pro',
    slug: 'pro',
    description: 'Para clínicas em crescimento que precisam de agendamento e métricas.',
    priceMonthly: 9900,
    priceYearly: 99000,
    maxProfiles: 3,
    maxLeadsPerMonth: 300,
    maxServicesPerProfile: 20,
    hasAppointments: true,
    hasAnalytics: true,
    hasCustomDomain: false,
    hasPrioritySupport: false,
    isPublic: true,
    displayOrder: 2,
  },
  {
    name: 'Enterprise',
    slug: 'enterprise',
    description: 'Para grandes clínicas e redes odontológicas com múltiplos profissionais.',
    priceMonthly: 29900,
    priceYearly: 299000,
    maxProfiles: null,
    maxLeadsPerMonth: null,
    maxServicesPerProfile: null,
    hasAppointments: true,
    hasAnalytics: true,
    hasCustomDomain: true,
    hasPrioritySupport: true,
    isPublic: true,
    displayOrder: 3,
  },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function seed(prisma: PrismaClient): Promise<void> {
  console.log('Seeding specialties…');
  for (const specialty of SPECIALTIES) {
    await prisma.specialty.upsert({
      where: { slug: specialty.slug },
      update: { name: specialty.name },
      create: specialty,
    });
  }
  console.log(`  ✓ ${SPECIALTIES.length} specialties upserted`);

  console.log('Seeding plans…');
  for (const plan of PLANS) {
    await prisma.plan.upsert({
      where: { slug: plan.slug },
      update: {
        name: plan.name,
        description: plan.description,
        priceMonthly: plan.priceMonthly,
        priceYearly: plan.priceYearly,
        maxProfiles: plan.maxProfiles,
        maxLeadsPerMonth: plan.maxLeadsPerMonth,
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
  console.log(`  ✓ ${PLANS.length} plans upserted`);
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set');
  }

  const pool = new Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    await seed(prisma);
    console.log('Seed completed successfully.');
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
