/**
 * dev-seed-pedro.ts — Seed manual de desenvolvimento para pedro@pedro.com.
 *
 * O que faz:
 *   Popula a clínica de pedro@pedro.com com dados realistas de desenvolvimento:
 *     - Perfil de profissional + serviço
 *     - 23 agendamentos distribuídos nos últimos 30 dias (18+ dias com receitas pagas)
 *     - Transações financeiras em 20+ dias distintos (receitas + despesas)
 *     - 6 produtos em estoque (normal / baixo / zerado / vencendo / vencido / inativo)
 *     - Movimentações de estoque para definir quantidades
 *     - Consentimentos de notificação WhatsApp
 *     - 5 notas fiscais (DRAFT, READY_TO_ISSUE, SIMULATED, ISSUED, CANCELED)
 *
 * Pré-requisito:
 *   pedro@pedro.com deve existir no banco e ter um clinicId vinculado.
 *
 * Como rodar:
 *   DATABASE_URL=<url> npx ts-node prisma/dev-seed-pedro.ts
 *
 * Idempotência:
 *   Se a clínica já tiver dados marcados com DF_PEDRO_DEV_SEED ou mais de 10
 *   agendamentos, o script encerra sem duplicar dados.
 *   Para recriar: delete os dados manualmente e re-execute.
 *
 * Quando remover:
 *   Quando existir um ambiente de staging com dados suficientes e este script
 *   não for mais necessário para testes locais de IA e estoque.
 */

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const USER_EMAIL = process.env.USER_EMAIL ?? 'pedro@pedro.com';
const SEED_PASSWORD = process.env.SEED_USER_PASSWORD ?? 'Pedro@123';
const SEED_MARKER = 'DF_PEDRO_DEV_SEED';
const TODAY = new Date();
TODAY.setHours(12, 0, 0, 0);

function daysAgo(n: number): Date {
  const d = new Date(TODAY);
  d.setDate(d.getDate() - n);
  return d;
}

function daysFromNow(n: number): Date {
  const d = new Date(TODAY);
  d.setDate(d.getDate() + n);
  return d;
}

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
    let user = await prisma.user.findUnique({ where: { email: USER_EMAIL } });

    if (!user) {
      console.log(`Usuário ${USER_EMAIL} não encontrado — criando...`);
      const clinic = await prisma.clinic.create({
        data: {
          name: 'Clínica Pedro',
          email: 'clinica@pedro.com',
          city: 'Rio de Janeiro',
          state: 'RJ',
        },
      });
      const hash = await bcrypt.hash(SEED_PASSWORD, 12);
      user = await prisma.user.create({
        data: {
          email: USER_EMAIL,
          passwordHash: hash,
          firstName: 'Pedro',
          lastName: 'Dono',
          role: 'OWNER',
          clinicId: clinic.id,
        },
      });
      console.log(`  ✓ Usuário e clínica criados`);
    }

    if (!user.clinicId) {
      throw new Error(`${USER_EMAIL} não está vinculado a nenhuma clínica.`);
    }

    const clinicId = user.clinicId;
    const userId = user.id;

    // ── 1. Idempotency guard ───────────────────────────────────────────────────
    const existingSeedAppts = await prisma.appointment.count({
      where: { clinicId, notes: { contains: SEED_MARKER } },
    });
    const existingAppts = await prisma.appointment.count({ where: { clinicId } });
    if (existingSeedAppts > 0 || existingAppts > 10) {
      console.log(`Clínica já tem ${existingAppts} agendamentos — seed ignorado.`);
      return;
    }

    // ── 2. Profile + Service ───────────────────────────────────────────────────
    const profile = await prisma.profile.upsert({
      where: { slug: 'pedro-dentista-seed' },
      update: { displayName: 'Dr. Pedro Dono', isPublished: true },
      create: {
        clinicId,
        userId,
        slug: 'pedro-dentista-seed',
        displayName: 'Dr. Pedro Dono',
        bio: 'Clínico geral — dados de desenvolvimento.',
        city: 'Rio de Janeiro',
        state: 'RJ',
        isPublished: true,
      },
    });

    // Upsert service — no unique except id, so find-or-create
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

    console.log(`✓ Perfil: ${profile.displayName} (${profile.slug})`);
    console.log(`✓ Serviço: ${service.name}`);

    // ── 3. Financial Categories ────────────────────────────────────────────────
    const catIncome = await prisma.financialCategory.upsert({
      where: { clinicId_type_name: { clinicId, type: 'INCOME', name: 'Serviços Odontológicos' } },
      update: {},
      create: { clinicId, type: 'INCOME', name: 'Serviços Odontológicos', color: '#10B981', isDefault: true },
    });

    const catExpense = await prisma.financialCategory.upsert({
      where: { clinicId_type_name: { clinicId, type: 'EXPENSE', name: 'Despesas Operacionais' } },
      update: {},
      create: { clinicId, type: 'EXPENSE', name: 'Despesas Operacionais', color: '#EF4444', isDefault: true },
    });

    console.log(`✓ Categorias financeiras criadas`);

    // ── 4. Appointments ────────────────────────────────────────────────────────
    // 22 agendamentos distribuídos nos últimos 30 dias — mix de status e pagamento.
    // days: 1-29 ago. Usando 20 dias distintos (pelo menos 18 com dados financeiros).
    type ApptSeed = {
      daysBack: number;
      hour: number;
      patient: string;
      phone: string;
      status: 'COMPLETED' | 'CANCELED' | 'NO_SHOW';
      payStatus: 'PAID' | 'PARTIALLY_PAID' | 'PAYMENT_PENDING';
      paidCents?: number;
      estimatedCents?: number;
      method?: 'PIX' | 'CREDIT_CARD' | 'CASH' | 'DEBIT_CARD' | 'HEALTH_INSURANCE';
    };

    const APPTS: ApptSeed[] = [
      { daysBack: 1,  hour: 9,  patient: 'Ana Lima',          phone: '(21) 99001-1111', status: 'COMPLETED',  payStatus: 'PAID',            paidCents: 28000, estimatedCents: 28000, method: 'PIX' },
      { daysBack: 2,  hour: 10, patient: 'Bruno Souza',        phone: '(21) 99002-2222', status: 'COMPLETED',  payStatus: 'PAID',            paidCents: 35000, estimatedCents: 35000, method: 'CREDIT_CARD' },
      { daysBack: 3,  hour: 9,  patient: 'Carla Mendes',       phone: '(21) 99003-3333', status: 'COMPLETED',  payStatus: 'PARTIALLY_PAID',  paidCents: 15000, estimatedCents: 30000, method: 'CASH' },
      { daysBack: 4,  hour: 14, patient: 'Diego Ferreira',     phone: '(21) 99004-4444', status: 'COMPLETED',  payStatus: 'PAID',            paidCents: 45000, estimatedCents: 45000, method: 'PIX' },
      { daysBack: 5,  hour: 11, patient: 'Elaine Costa',       phone: '(21) 99005-5555', status: 'COMPLETED',  payStatus: 'PAID',            paidCents: 22000, estimatedCents: 22000, method: 'DEBIT_CARD' },
      { daysBack: 6,  hour: 15, patient: 'Fábio Alves',        phone: '(21) 99006-6666', status: 'CANCELED',   payStatus: 'PAYMENT_PENDING' },
      { daysBack: 7,  hour: 9,  patient: 'Gisele Rodrigues',   phone: '(21) 99007-7777', status: 'COMPLETED',  payStatus: 'PAID',            paidCents: 32000, estimatedCents: 32000, method: 'PIX' },
      { daysBack: 8,  hour: 10, patient: 'Hugo Nunes',         phone: '(21) 99008-8888', status: 'COMPLETED',  payStatus: 'PAID',            paidCents: 25000, estimatedCents: 25000, method: 'CASH' },
      { daysBack: 9,  hour: 9,  patient: 'Íris Oliveira',      phone: '(21) 99009-9999', status: 'NO_SHOW',    payStatus: 'PAYMENT_PENDING' },
      { daysBack: 10, hour: 14, patient: 'João Martins',       phone: '(21) 99010-1010', status: 'COMPLETED',  payStatus: 'PAID',            paidCents: 38000, estimatedCents: 38000, method: 'PIX' },
      { daysBack: 11, hour: 9,  patient: 'Karen Santos',       phone: '(21) 99011-1111', status: 'COMPLETED',  payStatus: 'PAID',            paidCents: 29000, estimatedCents: 29000, method: 'HEALTH_INSURANCE' },
      { daysBack: 12, hour: 10, patient: 'Lucas Pereira',      phone: '(21) 99012-1212', status: 'COMPLETED',  payStatus: 'PAID',            paidCents: 42000, estimatedCents: 42000, method: 'CREDIT_CARD' },
      { daysBack: 13, hour: 16, patient: 'Mariana Tavares',    phone: '(21) 99013-1313', status: 'COMPLETED',  payStatus: 'PARTIALLY_PAID',  paidCents: 20000, estimatedCents: 35000, method: 'PIX' },
      { daysBack: 14, hour: 9,  patient: 'Nelson Barbosa',     phone: '(21) 99014-1414', status: 'COMPLETED',  payStatus: 'PAID',            paidCents: 31000, estimatedCents: 31000, method: 'DEBIT_CARD' },
      { daysBack: 15, hour: 11, patient: 'Olívia Castro',      phone: '(21) 99015-1515', status: 'COMPLETED',  payStatus: 'PAID',            paidCents: 27000, estimatedCents: 27000, method: 'PIX' },
      { daysBack: 16, hour: 10, patient: 'Waldemar Silva',     phone: '(21) 99023-2323', status: 'COMPLETED',  payStatus: 'PAID',            paidCents: 30000, estimatedCents: 30000, method: 'PIX' },
      { daysBack: 17, hour: 9,  patient: 'Paulo Xavier',       phone: '(21) 99016-1616', status: 'COMPLETED',  payStatus: 'PAID',            paidCents: 33000, estimatedCents: 33000, method: 'CASH' },
      { daysBack: 18, hour: 14, patient: 'Quésia Lima',        phone: '(21) 99017-1717', status: 'COMPLETED',  payStatus: 'PAID',            paidCents: 48000, estimatedCents: 48000, method: 'CREDIT_CARD' },
      { daysBack: 20, hour: 9,  patient: 'Ricardo Dias',       phone: '(21) 99018-1818', status: 'COMPLETED',  payStatus: 'PAID',            paidCents: 26000, estimatedCents: 26000, method: 'PIX' },
      { daysBack: 22, hour: 10, patient: 'Sônia Moreira',      phone: '(21) 99019-1919', status: 'COMPLETED',  payStatus: 'PAID',            paidCents: 34000, estimatedCents: 34000, method: 'CASH' },
      { daysBack: 24, hour: 9,  patient: 'Tiago Andrade',      phone: '(21) 99020-2020', status: 'COMPLETED',  payStatus: 'PAID',            paidCents: 37000, estimatedCents: 37000, method: 'PIX' },
      { daysBack: 26, hour: 14, patient: 'Úrsula Fonseca',     phone: '(21) 99021-2121', status: 'COMPLETED',  payStatus: 'PAID',            paidCents: 41000, estimatedCents: 41000, method: 'DEBIT_CARD' },
      { daysBack: 28, hour: 9,  patient: 'Vitor Cavalcanti',   phone: '(21) 99022-2222', status: 'COMPLETED',  payStatus: 'PAYMENT_PENDING', estimatedCents: 30000 },
    ];

    const createdAppointments: { id: string; payStatus: string; paidCents?: number; daysBack: number; method?: string }[] = [];

    for (const a of APPTS) {
      const apptDate = daysAgo(a.daysBack);
      const start = timeOf(a.hour);
      const end = addMinutes(start, 60);

      const paymentDate = a.payStatus === 'PAID' || a.payStatus === 'PARTIALLY_PAID'
        ? daysAgo(a.daysBack)
        : undefined;

      const appt = await prisma.appointment.create({
        data: {
          clinicId,
          profileId: profile.id,
          serviceId: service.id,
          patientName: a.patient,
          patientPhone: a.phone,
          appointmentDate: apptDate,
          startTime: start,
          endTime: end,
          durationMinutes: 60,
          status: a.status,
          paymentStatus: a.payStatus,
          estimatedAmountCents: a.estimatedCents,
          paidAmountCents: a.paidCents,
          paymentMethod: a.method,
          paymentDate,
          notes: `${SEED_MARKER} - consulta ficticia para desenvolvimento`,
          completedAt: a.status === 'COMPLETED' ? apptDate : undefined,
          canceledAt: a.status === 'CANCELED' ? apptDate : undefined,
        },
      });

      createdAppointments.push({
        id: appt.id,
        payStatus: a.payStatus,
        paidCents: a.paidCents,
        daysBack: a.daysBack,
        method: a.method,
      });
    }

    console.log(`✓ ${createdAppointments.length} agendamentos criados`);

    const FUTURE_APPTS = [
      { daysForward: 1, hour: 9, patient: 'Helena Duarte', phone: '(21) 99101-0101', status: 'CONFIRMED' as const, payStatus: 'PAYMENT_PENDING' as const, estimatedCents: 32000 },
      { daysForward: 3, hour: 14, patient: 'Igor Menezes', phone: '(21) 99102-0202', status: 'PENDING' as const, payStatus: 'PAYMENT_PENDING' as const, estimatedCents: 28000 },
      { daysForward: 7, hour: 10, patient: 'Larissa Campos', phone: '(21) 99103-0303', status: 'CONFIRMED' as const, payStatus: 'PARTIALLY_PAID' as const, paidCents: 10000, estimatedCents: 30000, method: 'PIX' as const },
    ];

    for (const a of FUTURE_APPTS) {
      const apptDate = daysFromNow(a.daysForward);
      const start = timeOf(a.hour);
      await prisma.appointment.create({
        data: {
          clinicId,
          profileId: profile.id,
          serviceId: service.id,
          patientName: a.patient,
          patientPhone: a.phone,
          appointmentDate: apptDate,
          startTime: start,
          endTime: addMinutes(start, 60),
          durationMinutes: 60,
          status: a.status,
          paymentStatus: a.payStatus,
          estimatedAmountCents: a.estimatedCents,
          paidAmountCents: a.paidCents,
          paymentMethod: a.method,
          notes: `${SEED_MARKER} - consulta futura ficticia`,
        },
      });
    }

    console.log(`✓ ${FUTURE_APPTS.length} agendamentos futuros criados`);

    // ── 5. Financial Transactions ──────────────────────────────────────────────
    let incomeCount = 0;
    let expenseCount = 0;

    for (const a of createdAppointments) {
      if ((a.payStatus === 'PAID' || a.payStatus === 'PARTIALLY_PAID') && a.paidCents) {
        // Income transaction linked to appointment
        await prisma.financialTransaction.create({
          data: {
            clinicId,
            type: 'INCOME',
            source: 'SERVICE_PAYMENT',
            categoryId: catIncome.id,
            appointmentId: a.id,
            profileId: profile.id,
            serviceId: service.id,
            amount: a.paidCents / 100,
            description: 'Consulta clínica geral',
            transactionDate: daysAgo(a.daysBack),
            status: 'PAID',
            paidAt: daysAgo(a.daysBack),
            createdByUserId: userId,
          },
        });
        incomeCount++;
      }
    }

    // Manual expense transactions spread across different days
    const EXPENSES = [
      { daysBack: 2,  desc: 'Material descartável — luvas e máscaras', amount: 12000 },
      { daysBack: 5,  desc: 'Manutenção do equipamento de raio-X',     amount: 35000 },
      { daysBack: 8,  desc: 'Aluguel da sala de atendimento',          amount: 80000 },
      { daysBack: 11, desc: 'Compra de resinas compostas',             amount: 22000 },
      { daysBack: 16, desc: 'Internet e telefone',                      amount: 18000 },
      { daysBack: 19, desc: 'Serviço de contabilidade',                 amount: 25000 },
      { daysBack: 23, desc: 'Material de escritório',                   amount: 8500  },
      { daysBack: 27, desc: 'Energia elétrica',                         amount: 31000 },
    ];

    for (const e of EXPENSES) {
      await prisma.financialTransaction.create({
        data: {
          clinicId,
          type: 'EXPENSE',
          source: 'MANUAL',
          categoryId: catExpense.id,
          amount: e.amount / 100,
          description: e.desc,
          transactionDate: daysAgo(e.daysBack),
          status: 'PAID',
          paidAt: daysAgo(e.daysBack),
          createdByUserId: userId,
        },
      });
      expenseCount++;
    }

    console.log(`✓ Transações financeiras: ${incomeCount} receitas, ${expenseCount} despesas`);

    // ── 6. Inventory ───────────────────────────────────────────────────────────
    const stockCat = await prisma.stockCategory.upsert({
      where: { clinicId_name: { clinicId, name: 'Materiais Odontológicos' } },
      update: {},
      create: { clinicId, name: 'Materiais Odontológicos', color: '#6366F1' },
    });

    const stockCatDescartaveis = await prisma.stockCategory.upsert({
      where: { clinicId_name: { clinicId, name: 'Descartáveis e EPI' } },
      update: {},
      create: { clinicId, name: 'Descartáveis e EPI', color: '#F59E0B' },
    });

    type ProductSeed = {
      name: string;
      catId: string;
      unit: string;
      currentQty: number;
      minQty: number;
      purchasePrice?: number;
      expiresAt?: Date;
      isActive?: boolean;
    };

    const PRODUCTS: ProductSeed[] = [
      {
        name: 'Resina Composta A2 — Filtek Z350',
        catId: stockCat.id,
        unit: 'seringa',
        currentQty: 12,
        minQty: 3,
        purchasePrice: 8500,
      },
      {
        name: 'Ácido fosfórico 37% gel',
        catId: stockCat.id,
        unit: 'frasco',
        currentQty: 2,
        minQty: 3,
        purchasePrice: 2200,
      },
      {
        name: 'Anestésico lidocaína 2%',
        catId: stockCat.id,
        unit: 'caixa',
        currentQty: 0,
        minQty: 2,
        purchasePrice: 15000,
      },
      {
        name: 'Guta-percha calibre 25 — caixa c/120',
        catId: stockCat.id,
        unit: 'caixa',
        currentQty: 3,
        minQty: 1,
        purchasePrice: 4800,
        // expires in 20 days
        expiresAt: new Date('2026-06-06'),
      },
      {
        name: 'Hidróxido de cálcio pasta',
        catId: stockCat.id,
        unit: 'tubo',
        currentQty: 1,
        minQty: 2,
        purchasePrice: 3500,
        // already expired
        expiresAt: new Date('2026-04-30'),
      },
      {
        name: 'Luvas cirúrgicas tam. M — caixa c/100',
        catId: stockCatDescartaveis.id,
        unit: 'caixa',
        currentQty: 8,
        minQty: 2,
        purchasePrice: 6500,
        isActive: false,
      },
    ];

    const createdProducts: string[] = [];

    for (const p of PRODUCTS) {
      const product = await prisma.stockProduct.create({
        data: {
          clinicId,
          categoryId: p.catId,
          name: p.name,
          unit: p.unit,
          currentQuantity: p.currentQty,
          minQuantity: p.minQty,
          purchasePrice: p.purchasePrice,
          expiresAt: p.expiresAt,
          isActive: p.isActive !== false,
        },
      });

      if (p.currentQty > 0) {
        await prisma.stockMovement.create({
          data: {
            clinicId,
            productId: product.id,
            type: 'IN',
            quantity: p.currentQty,
            previousQuantity: 0,
            newQuantity: p.currentQty,
            reason: 'Estoque inicial — seed de desenvolvimento',
            performedByUserId: userId,
          },
        });
      }

      createdProducts.push(product.id);
    }

    console.log(`✓ ${createdProducts.length} produtos em estoque criados`);

    const movementProductIds = createdProducts.slice(0, 4);
    for (let day = 1; day <= 20; day++) {
      const productId = movementProductIds[day % movementProductIds.length];
      await prisma.stockMovement.create({
        data: {
          clinicId,
          productId,
          type: day % 5 === 0 ? 'LOSS' : day % 2 === 0 ? 'OUT' : 'IN',
          quantity: 1,
          previousQuantity: 10,
          newQuantity: day % 5 === 0 || day % 2 === 0 ? 9 : 11,
          reason: `${SEED_MARKER} - atividade historica de estoque`,
          notes: 'Movimentacao ficticia para testar IA de estoque.',
          performedByUserId: userId,
          createdAt: daysAgo(day),
        },
      });
    }

    console.log('✓ 20 movimentações históricas de estoque criadas');

    // ── 7. Notification Consents ───────────────────────────────────────────────
    const CONSENT_PHONES = ['21990011111', '21990022222', '21990033333', '21990044444'];
    let consentsCreated = 0;

    for (const phone of CONSENT_PHONES) {
      await prisma.notificationConsent.create({
        data: {
          clinicId,
          phone,
          channel: 'WHATSAPP',
          scope: 'UTILITY',
          granted: true,
          grantedAt: daysAgo(15),
          source: 'MANUAL',
        },
      });
      consentsCreated++;
    }

    // One revoked consent
    await prisma.notificationConsent.create({
      data: {
        clinicId,
        phone: '21990055555',
        channel: 'WHATSAPP',
        scope: 'UTILITY',
        granted: false,
        grantedAt: daysAgo(30),
        revokedAt: daysAgo(5),
        source: 'MANUAL',
      },
    });

    console.log(`✓ ${consentsCreated + 1} consentimentos de notificação criados`);

    // ── 9. Service Invoices ────────────────────────────────────────────────────
    const INVOICES = [
      {
        status: 'DRAFT' as const,
        customerName: 'Ana Lima',
        desc: 'Consulta clínica geral e limpeza dental.',
        amountCents: 28000,
        competence: new Date('2026-05-01'),
      },
      {
        status: 'READY_TO_ISSUE' as const,
        customerName: 'Bruno Souza',
        desc: 'Restauração em resina composta — dente 14.',
        amountCents: 35000,
        competence: new Date('2026-05-01'),
      },
      {
        status: 'SIMULATED' as const,
        customerName: 'Diego Ferreira',
        desc: 'Clareamento dental — sessão única em consultório.',
        amountCents: 45000,
        competence: new Date('2026-04-01'),
        invoiceNumber: 'SIM-00101',
      },
      {
        status: 'ISSUED' as const,
        customerName: 'Karen Santos',
        desc: 'Tratamento de canal (endodontia) — dente 16.',
        amountCents: 85000,
        competence: new Date('2026-04-01'),
        invoiceNumber: '2026-00042',
        issueDate: daysAgo(15),
      },
      {
        status: 'CANCELED' as const,
        customerName: 'Fábio Alves',
        desc: 'Consulta cancelada — ressarcimento.',
        amountCents: 22000,
        competence: new Date('2026-04-01'),
        canceledAt: daysAgo(20),
      },
    ];

    for (const [index, inv] of INVOICES.entries()) {
      const invoice = await prisma.serviceInvoice.create({
        data: {
          clinicId,
          createdByUserId: userId,
          appointmentId: createdAppointments[index]?.id,
          status: inv.status,
          environment: 'LOCAL',
          isLegalDocument: inv.status === 'ISSUED',
          customerName: inv.customerName,
          serviceDescription: inv.desc,
          serviceCode: '14.01',
          amountCents: inv.amountCents,
          issRate: 5,
          issAmountCents: Math.round(inv.amountCents * 0.05),
          currency: 'BRL',
          competenceDate: inv.competence,
          invoiceNumber: 'invoiceNumber' in inv ? inv.invoiceNumber : undefined,
          simulatedIssueDate: inv.status === 'SIMULATED' ? daysAgo(10) : undefined,
          issueDate: 'issueDate' in inv ? inv.issueDate : undefined,
          canceledAt: 'canceledAt' in inv ? inv.canceledAt : undefined,
        },
      });

      await prisma.fiscalInvoiceEvent.create({
        data: {
          serviceInvoiceId: invoice.id,
          eventType: 'STATUS_CHANGED',
          previousStatus: 'DRAFT',
          nextStatus: inv.status,
          message: `Status definido pelo seed de desenvolvimento: ${inv.status}`,
          createdByUserId: userId,
        },
      });
    }

    console.log(`✓ ${INVOICES.length} notas fiscais criadas`);

    // ── 10. Notification Preference (enable WhatsApp) ──────────────────────────
    await prisma.notificationPreference.upsert({
      where: { clinicId },
      update: { whatsappEnabled: true },
      create: { clinicId, whatsappEnabled: true, reminderHoursBefore: 24 },
    });

    console.log(`✓ Preferência WhatsApp ativada`);
    console.log('');
    console.log('Seed concluído com sucesso!');
    console.log(`  Clínica: ${clinicId}`);
    console.log(`  Perfil:  ${profile.id}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Seed falhou:', err);
  process.exit(1);
});
