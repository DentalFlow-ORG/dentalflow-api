/**
 * dev-seed-fiscal.ts — Script de seed manual para desenvolvimento do módulo fiscal.
 *
 * O que faz:
 *   Cria duas ServiceInvoice de exemplo vinculadas a um usuário existente no banco:
 *     - Nota 1: status READY_TO_ISSUE (pronta para emissão simulada)
 *     - Nota 2: status SIMULATED (emissão local já executada)
 *
 * Pré-requisito:
 *   O usuário informado em USER_EMAIL deve existir no banco e estar vinculado a uma clínica.
 *   Por padrão usa pedro@pedro.com. Sobrescreva com a variável USER_EMAIL.
 *
 * Como rodar:
 *   DATABASE_URL=<sua-url> npx ts-node prisma/dev-seed-fiscal.ts
 *   ou
 *   DATABASE_URL=<sua-url> USER_EMAIL=outro@email.com npx ts-node prisma/dev-seed-fiscal.ts
 *
 * Quando remover:
 *   Quando o módulo fiscal estiver totalmente validado em staging e não houver
 *   mais necessidade de popular dados fiscais manualmente em dev.
 */

import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const USER_EMAIL = process.env.USER_EMAIL ?? 'pedro@pedro.com';

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set');

  const adapter = new PrismaPg({ connectionString });
  const prisma = new PrismaClient({ adapter });

  try {
    const user = await prisma.user.findUnique({
      where: { email: USER_EMAIL },
    });
    if (!user)
      throw new Error(
        `Usuário ${USER_EMAIL} não encontrado. Crie a conta antes de rodar este script.`,
      );
    if (!user.clinicId)
      throw new Error(`${USER_EMAIL} não está vinculado a nenhuma clínica.`);

    const clinicId = user.clinicId;
    const createdByUserId = user.id;

    const invoice1 = await prisma.serviceInvoice.create({
      data: {
        clinicId,
        createdByUserId,
        status: 'READY_TO_ISSUE',
        environment: 'LOCAL',
        isLegalDocument: false,
        customerName: 'Maria Aparecida Santos',
        customerDocument: '123.456.789-00',
        customerEmail: 'maria.santos@email.com',
        customerPhone: '(11) 98765-4321',
        serviceDescription:
          'Consulta odontológica de rotina, limpeza dentária profissional e aplicação de flúor. Atendimento realizado em 02/05/2026.',
        serviceCode: '14.01',
        amountCents: 28000,
        issRate: 5,
        issAmountCents: 1400,
        currency: 'BRL',
        competenceDate: new Date('2026-05-01'),
        notes: 'Paciente retorna em 6 meses para nova avaliação.',
      },
    });

    await prisma.fiscalInvoiceEvent.create({
      data: {
        serviceInvoiceId: invoice1.id,
        eventType: 'STATUS_CHANGED',
        previousStatus: 'DRAFT',
        nextStatus: 'READY_TO_ISSUE',
        message: 'Nota marcada como pronta para emissão.',
        createdByUserId,
      },
    });

    const invoice2 = await prisma.serviceInvoice.create({
      data: {
        clinicId,
        createdByUserId,
        status: 'SIMULATED',
        environment: 'LOCAL',
        isLegalDocument: false,
        invoiceNumber: 'SIM-00042',
        verificationCode: 'LOCAL-SIM',
        customerName: 'João Carlos Oliveira',
        customerDocument: '987.654.321-00',
        customerEmail: 'joao.oliveira@empresa.com.br',
        customerPhone: '(11) 91234-5678',
        serviceDescription:
          'Tratamento de canal (endodontia) em dente 36 – molar inferior esquerdo. Inclui duas sessões realizadas em 18/04/2026 e 30/04/2026.',
        serviceCode: '14.01',
        amountCents: 85000,
        issRate: 5,
        issAmountCents: 4250,
        currency: 'BRL',
        competenceDate: new Date('2026-04-01'),
        simulatedIssueDate: new Date('2026-05-02'),
        notes:
          'Paciente possui plano odontológico. Nota emitida para reembolso parcial.',
      },
    });

    await prisma.fiscalInvoiceEvent.createMany({
      data: [
        {
          serviceInvoiceId: invoice2.id,
          eventType: 'STATUS_CHANGED',
          previousStatus: 'DRAFT',
          nextStatus: 'READY_TO_ISSUE',
          message: 'Nota marcada como pronta para emissão.',
          createdByUserId,
        },
        {
          serviceInvoiceId: invoice2.id,
          eventType: 'STATUS_CHANGED',
          previousStatus: 'READY_TO_ISSUE',
          nextStatus: 'SIMULATED',
          message: 'Emissão simulada com sucesso em modo LOCAL.',
          createdByUserId,
        },
      ],
    });

    console.log(
      `✓ Nota 1 criada: ${invoice1.id} (Maria Aparecida Santos – R$ 280,00)`,
    );
    console.log(
      `✓ Nota 2 criada: ${invoice2.id} (João Carlos Oliveira – R$ 850,00)`,
    );
    console.log('Seed concluído!');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Seed falhou:', err);
  process.exit(1);
});
