/**
 * dev-seed-today-appointments.ts — Seed de agendamentos para hoje (validação do gráfico donut).
 *
 * O que faz:
 *   Cria 7 agendamentos na data de hoje para pedro@pedro.com, cobrindo todos os
 *   5 status possíveis (CONFIRMED x2, PENDING x2, COMPLETED, CANCELED, NO_SHOW).
 *
 * Pré-requisito:
 *   dev-seed-pedro.ts já deve ter sido executado (usuário, clínica, perfil e serviço existem).
 *
 * Como rodar:
 *   DATABASE_URL=<url> npx ts-node prisma/dev-seed-today-appointments.ts
 *
 * Idempotência:
 *   Se já existir qualquer agendamento marcado com DF_PEDRO_TODAY_SEED na data de hoje,
 *   o script encerra sem duplicar dados.
 */

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const USER_EMAIL = process.env.USER_EMAIL ?? 'pedro@pedro.com';
const SEED_MARKER = 'DF_PEDRO_TODAY_SEED';

function timeOf(hour: number, minute = 0): Date {
  const d = new Date('1970-01-01T00:00:00.000Z');
  d.setUTCHours(hour, minute, 0, 0);
  return d;
}

function addMinutes(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60 * 1000);
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  try {
    // ── 0. Resolve user ────────────────────────────────────────────────────────
    const user = await prisma.user.findUnique({ where: { email: USER_EMAIL } });
    if (!user) throw new Error(`Usuário ${USER_EMAIL} não encontrado. Execute dev-seed-pedro.ts primeiro.`);
    if (!user.clinicId) throw new Error(`${USER_EMAIL} não está vinculado a nenhuma clínica.`);

    const clinicId = user.clinicId;
    console.log(`✓ Usuário: ${USER_EMAIL} (clinicId: ${clinicId})`);

    // ── 1. Resolve profile — use existing profile for this user/clinic ─────────
    let profile = await prisma.profile.findUnique({ where: { userId: user.id } });
    if (!profile) {
      profile = await prisma.profile.findFirst({ where: { clinicId } });
    }
    if (!profile) throw new Error('Nenhum perfil encontrado para esta clínica. Crie um perfil primeiro.');

    // ── 1b. Resolve service — find or create on the profile ───────────────────
    let service = await prisma.service.findFirst({
      where: { profileId: profile.id, name: 'Consulta Clínica Geral' },
    });
    if (!service) {
      service = await prisma.service.create({
        data: {
          profileId: profile.id,
          clinicId,
          name: 'Consulta Clínica Geral',
          durationMinutes: 60,
          priceFrom: 250,
          priceTo: 350,
          isActive: true,
        },
      });
    }

    console.log(`✓ Perfil: ${profile.displayName}`);
    console.log(`✓ Serviço: ${service.name}`);

    // ── 2. Date bounds for today ───────────────────────────────────────────────
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];
    const [y, m, d] = todayStr.split('-').map(Number);
    const todayStart = new Date(Date.UTC(y, m - 1, d));
    const todayEnd = new Date(Date.UTC(y, m - 1, d + 1));

    console.log(`✓ Data alvo: ${todayStr}`);

    // ── 3. Idempotency guard ───────────────────────────────────────────────────
    const existingCount = await prisma.appointment.count({
      where: {
        clinicId,
        appointmentDate: { gte: todayStart, lt: todayEnd },
        notes: { contains: SEED_MARKER },
      },
    });

    if (existingCount > 0) {
      console.log(`Seed já executado — ${existingCount} agendamentos com ${SEED_MARKER} já existem para hoje.`);
      return;
    }

    // ── 4. Create appointments ─────────────────────────────────────────────────
    type ApptSeed = {
      hour: number;
      patient: string;
      phone: string;
      status: 'CONFIRMED' | 'PENDING' | 'COMPLETED' | 'CANCELED' | 'NO_SHOW';
      payStatus: 'PAID' | 'PARTIALLY_PAID' | 'PAYMENT_PENDING';
      estimatedCents?: number;
      paidCents?: number;
      method?: 'PIX' | 'CREDIT_CARD' | 'CASH' | 'DEBIT_CARD';
    };

    const APPTS: ApptSeed[] = [
      {
        hour: 8,
        patient: 'Mariana Fonseca',
        phone: '(21) 98801-0001',
        status: 'CONFIRMED',
        payStatus: 'PAYMENT_PENDING',
        estimatedCents: 28000,
      },
      {
        hour: 9,
        patient: 'Carlos Rocha',
        phone: '(21) 98801-0002',
        status: 'CONFIRMED',
        payStatus: 'PARTIALLY_PAID',
        estimatedCents: 32000,
        paidCents: 15000,
        method: 'PIX',
      },
      {
        hour: 10,
        patient: 'Fernanda Lima',
        phone: '(21) 98801-0003',
        status: 'PENDING',
        payStatus: 'PAYMENT_PENDING',
        estimatedCents: 25000,
      },
      {
        hour: 11,
        patient: 'Rafael Duarte',
        phone: '(21) 98801-0004',
        status: 'PENDING',
        payStatus: 'PAYMENT_PENDING',
        estimatedCents: 30000,
      },
      {
        hour: 13,
        patient: 'Beatriz Melo',
        phone: '(21) 98801-0005',
        status: 'COMPLETED',
        payStatus: 'PAID',
        estimatedCents: 35000,
        paidCents: 35000,
        method: 'PIX',
      },
      {
        hour: 14,
        patient: 'Gustavo Pires',
        phone: '(21) 98801-0006',
        status: 'CANCELED',
        payStatus: 'PAYMENT_PENDING',
        estimatedCents: 28000,
      },
      {
        hour: 15,
        patient: 'Tatiane Cruz',
        phone: '(21) 98801-0007',
        status: 'NO_SHOW',
        payStatus: 'PAYMENT_PENDING',
        estimatedCents: 28000,
      },
    ];

    let created = 0;
    const summary: Record<string, number> = {};

    for (const a of APPTS) {
      const start = timeOf(a.hour);
      const end = addMinutes(start, 60);

      await prisma.appointment.create({
        data: {
          clinicId,
          profileId: profile.id,
          serviceId: service.id,
          patientName: a.patient,
          patientPhone: a.phone,
          appointmentDate: todayStart,
          startTime: start,
          endTime: end,
          durationMinutes: 60,
          status: a.status,
          paymentStatus: a.payStatus,
          estimatedAmountCents: a.estimatedCents,
          paidAmountCents: a.paidCents,
          paymentMethod: a.method,
          paymentDate: a.payStatus === 'PAID' ? todayStart : undefined,
          completedAt: a.status === 'COMPLETED' ? todayStart : undefined,
          canceledAt: a.status === 'CANCELED' ? todayStart : undefined,
          notes: `${SEED_MARKER} - consulta ficticia para validacao do grafico donut`,
        },
      });

      summary[a.status] = (summary[a.status] ?? 0) + 1;
      created++;
    }

    console.log('');
    console.log(`✓ ${created} agendamentos criados para ${todayStr}:`);
    for (const [status, count] of Object.entries(summary)) {
      console.log(`    ${status}: ${count}`);
    }
    console.log('');
    console.log('Seed concluído. Recarregue o dashboard para ver o gráfico de hoje.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Seed falhou:', err);
  process.exit(1);
});
