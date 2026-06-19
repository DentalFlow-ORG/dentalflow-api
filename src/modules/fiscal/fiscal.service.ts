import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  NotImplementedException,
} from '@nestjs/common';
import {
  AppointmentPaymentStatus,
  AppointmentStatus,
  FiscalProvider,
  FiscalProviderMode,
  Prisma,
  ServiceInvoiceStatus,
  UserRole,
} from '@prisma/client';
import { fiscalConfig } from '../../config/fiscal.config';
import { PrismaService } from '../../prisma/prisma.service';
import { brazilCurrentIsoMonth } from '../../common/utils/brazil-timezone';
import {
  CancelInvoiceDto,
  CreateServiceInvoiceDto,
  ListAppointmentsForInvoiceDto,
  ListInvoicesDto,
  UpdateServiceInvoiceDto,
} from './dto/invoice.dto';
import { UpsertFiscalProfileDto } from './dto/upsert-fiscal-profile.dto';
import { FISCAL_INVOICE_PROVIDER } from './fiscal.tokens';
import { FiscalInvoiceProvider } from './providers/fiscal-invoice-provider.interface';

type FiscalUser = {
  id: string;
  role: UserRole;
};

const EDITABLE_STATUSES: ServiceInvoiceStatus[] = [
  ServiceInvoiceStatus.DRAFT,
  ServiceInvoiceStatus.READY_TO_ISSUE,
];

@Injectable()
export class FiscalService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(FISCAL_INVOICE_PROVIDER)
    private readonly provider: FiscalInvoiceProvider,
  ) {}

  async getFiscalProfile(clinicId: string) {
    const profile = await this.prisma.clinicFiscalProfile.findUnique({
      where: { clinicId },
    });

    return {
      profile,
      providerMode: fiscalConfig.providerMode,
      realIssuingEnabled: false,
      message:
        'A emissão real de NFS-e ainda não está ativa. Este módulo opera em modo local/simulação.',
    };
  }

  async upsertFiscalProfile(
    clinicId: string,
    dto: UpsertFiscalProfileDto,
  ) {
    const fiscalProvider = dto.fiscalProvider ?? FiscalProvider.LOCAL;
    const fiscalProviderMode =
      dto.fiscalProviderMode ?? FiscalProviderMode.LOCAL;
    const isConfigured = this.isFiscalProfileConfigured(dto);

    return this.prisma.clinicFiscalProfile.upsert({
      where: { clinicId },
      create: {
        ...dto,
        clinicId,
        documentNumber: this.onlyDigits(dto.documentNumber),
        addressZipCode: this.onlyDigits(dto.addressZipCode),
        addressState: dto.addressState.toUpperCase(),
        fiscalProvider,
        fiscalProviderMode,
        isConfigured,
      },
      update: {
        ...dto,
        documentNumber: this.onlyDigits(dto.documentNumber),
        addressZipCode: this.onlyDigits(dto.addressZipCode),
        addressState: dto.addressState.toUpperCase(),
        fiscalProvider,
        fiscalProviderMode,
        isConfigured,
      },
    });
  }

  async getSummary(clinicId: string) {
    // competenceDate is stored as UTC midnight — derive first-of-month from the
    // Brazil calendar so the window doesn't shift during 00:00-03:00 UTC.
    const [bmy, bmm] = brazilCurrentIsoMonth().split('-').map(Number);
    const startOfMonth = new Date(Date.UTC(bmy, bmm - 1, 1));

    const statusRows = await this.prisma.serviceInvoice.groupBy({
      by: ['status'],
      where: { clinicId },
      _count: { _all: true },
    });
    const monthRows = await this.prisma.serviceInvoice.findMany({
      where: {
        clinicId,
        competenceDate: { gte: startOfMonth },
        status: { not: ServiceInvoiceStatus.CANCELED },
      },
      select: { amountCents: true },
    });
    const profile = await this.prisma.clinicFiscalProfile.findUnique({
      where: { clinicId },
    });

    const counts = Object.values(ServiceInvoiceStatus).reduce<
      Record<ServiceInvoiceStatus, number>
    >((result, status) => {
      result[status] =
        statusRows.find((row) => row.status === status)?._count._all ?? 0;
      return result;
    }, {} as Record<ServiceInvoiceStatus, number>);

    return {
      counts,
      monthTotalCents: monthRows.reduce(
        (total, invoice) => total + invoice.amountCents,
        0,
      ),
      configurationPending: !profile?.isConfigured,
      providerMode: profile?.fiscalProviderMode ?? FiscalProviderMode.LOCAL,
      realIssuingEnabled: false,
    };
  }

  async listInvoices(clinicId: string, query: ListInvoicesDto) {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 100) : 20;
    const where: Prisma.ServiceInvoiceWhereInput = {
      clinicId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.customer?.trim()
        ? {
            customerName: {
              contains: query.customer.trim(),
              mode: 'insensitive',
            },
          }
        : {}),
      ...this.competenceDateRange(query.from, query.to),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.serviceInvoice.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.serviceInvoice.count({ where }),
    ]);

    return { data, total, page, limit };
  }

  async getInvoice(clinicId: string, invoiceId: string) {
    const invoice = await this.prisma.serviceInvoice.findFirst({
      where: { id: invoiceId, clinicId },
      include: {
        appointment: {
          select: {
            id: true,
            patientName: true,
            appointmentDate: true,
            service: { select: { id: true, name: true } },
          },
        },
        events: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!invoice) {
      throw new NotFoundException('Nota fiscal não encontrada.');
    }

    return invoice;
  }

  async createInvoice(
    clinicId: string,
    user: FiscalUser,
    dto: CreateServiceInvoiceDto,
  ) {
    await this.assertLinksBelongToClinic(clinicId, dto);

    if (dto.appointmentId) {
      const duplicate = await this.prisma.serviceInvoice.findFirst({
        where: {
          clinicId,
          appointmentId: dto.appointmentId,
          status: { not: ServiceInvoiceStatus.CANCELED },
        },
        select: { id: true },
      });
      if (duplicate) {
        throw new ConflictException(
          'Já existe uma nota fiscal ativa vinculada a esta consulta.',
        );
      }
    }

    const profile = await this.prisma.clinicFiscalProfile.findUnique({
      where: { clinicId },
    });

    const invoice = await this.prisma.serviceInvoice.create({
      data: {
        clinicId,
        createdByUserId: user.id,
        patientId: dto.patientId,
        appointmentId: dto.appointmentId,
        customerName: dto.customerName.trim(),
        customerDocument: dto.customerDocument
          ? this.onlyDigits(dto.customerDocument)
          : null,
        customerEmail: dto.customerEmail,
        customerPhone: dto.customerPhone,
        serviceDescription: dto.serviceDescription.trim(),
        serviceCode: dto.serviceCode ?? profile?.serviceCode,
        amountCents: dto.amountCents,
        deductionsCents: dto.deductionsCents,
        issRate: dto.issRate,
        issAmountCents: this.calculateIssCents(dto.amountCents, dto.issRate),
        competenceDate: this.dateOnly(dto.competenceDate),
        notes: dto.notes,
        environment: FiscalProviderMode.LOCAL,
        isLegalDocument: false,
      },
    });

    await this.createEvent(invoice.id, 'DRAFT_CREATED', null, invoice.status, user.id, {
      mode: 'LOCAL',
      legalValidity: false,
    });

    return invoice;
  }

  async updateInvoice(
    clinicId: string,
    user: FiscalUser,
    invoiceId: string,
    dto: UpdateServiceInvoiceDto,
  ) {
    const invoice = await this.assertInvoiceAccess(clinicId, invoiceId);
    this.assertEditable(invoice.status);
    if (user.role === UserRole.ASSISTANT && invoice.status !== ServiceInvoiceStatus.DRAFT) {
      throw new ForbiddenException(
        'Assistentes podem editar apenas rascunhos fiscais.',
      );
    }

    await this.assertLinksBelongToClinic(clinicId, dto);
    const data: Prisma.ServiceInvoiceUpdateInput = {
      updatedByUser: { connect: { id: user.id } },
      ...(dto.patientId !== undefined ? { patient: dto.patientId ? { connect: { id: dto.patientId } } : { disconnect: true } } : {}),
      ...(dto.appointmentId !== undefined ? { appointment: dto.appointmentId ? { connect: { id: dto.appointmentId } } : { disconnect: true } } : {}),
      ...(dto.customerName !== undefined
        ? { customerName: dto.customerName.trim() }
        : {}),
      ...(dto.customerDocument !== undefined
        ? {
            customerDocument: dto.customerDocument
              ? this.onlyDigits(dto.customerDocument)
              : null,
          }
        : {}),
      ...(dto.customerEmail !== undefined ? { customerEmail: dto.customerEmail } : {}),
      ...(dto.customerPhone !== undefined ? { customerPhone: dto.customerPhone } : {}),
      ...(dto.serviceDescription !== undefined
        ? { serviceDescription: dto.serviceDescription.trim() }
        : {}),
      ...(dto.serviceCode !== undefined ? { serviceCode: dto.serviceCode } : {}),
      ...(dto.amountCents !== undefined ? { amountCents: dto.amountCents } : {}),
      ...(dto.deductionsCents !== undefined
        ? { deductionsCents: dto.deductionsCents }
        : {}),
      ...(dto.issRate !== undefined ? { issRate: dto.issRate } : {}),
      ...(dto.competenceDate !== undefined
        ? { competenceDate: this.dateOnly(dto.competenceDate) }
        : {}),
      ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
    };

    const amount = dto.amountCents ?? invoice.amountCents;
    const issRate =
      dto.issRate ?? (invoice.issRate === null ? undefined : Number(invoice.issRate));
    data.issAmountCents = this.calculateIssCents(amount, issRate);

    const updated = await this.prisma.serviceInvoice.update({
      where: { id: invoice.id },
      data,
    });

    await this.createEvent(
      invoice.id,
      'DRAFT_UPDATED',
      invoice.status,
      updated.status,
      user.id,
    );

    return updated;
  }

  async markReady(clinicId: string, user: FiscalUser, invoiceId: string) {
    this.assertOwner(user);
    const invoice = await this.assertInvoiceAccess(clinicId, invoiceId);
    this.assertEditable(invoice.status);
    await this.assertReadyForIssue(clinicId, invoice.id);

    const updated = await this.prisma.serviceInvoice.update({
      where: { id: invoice.id },
      data: {
        status: ServiceInvoiceStatus.READY_TO_ISSUE,
        updatedByUserId: user.id,
        errorMessage: null,
      },
    });
    await this.createEvent(
      invoice.id,
      'MARKED_READY',
      invoice.status,
      updated.status,
      user.id,
    );
    return updated;
  }

  async simulateIssue(clinicId: string, user: FiscalUser, invoiceId: string) {
    this.assertOwner(user);
    const invoice = await this.assertInvoiceAccess(clinicId, invoiceId);
    if (invoice.status !== ServiceInvoiceStatus.READY_TO_ISSUE) {
      throw new BadRequestException(
        'A nota precisa estar pronta para emissão antes da simulação.',
      );
    }
    await this.assertReadyForIssue(clinicId, invoice.id);

    const result = await this.provider.issueServiceInvoice({
      invoiceId: invoice.id,
      customerName: invoice.customerName,
      serviceDescription: invoice.serviceDescription,
      amountCents: invoice.amountCents,
      currency: invoice.currency,
      competenceDate: invoice.competenceDate,
    });

    const updated = await this.prisma.serviceInvoice.update({
      where: { id: invoice.id },
      data: {
        status: ServiceInvoiceStatus.SIMULATED,
        environment: FiscalProviderMode.LOCAL,
        isLegalDocument: false,
        externalInvoiceId: result.externalInvoiceId,
        invoiceNumber: result.invoiceNumber,
        verificationCode: result.verificationCode,
        simulatedIssueDate: result.simulatedIssueDate,
        issuedByUserId: user.id,
        providerRawResponse: result.rawResponse as Prisma.InputJsonValue,
        errorMessage: null,
      },
    });

    await this.createEvent(
      invoice.id,
      'SIMULATED_ISSUE',
      invoice.status,
      updated.status,
      user.id,
      { legalValidity: false },
    );

    return {
      invoice: updated,
      message:
        'Simulação de emissão concluída. Este documento não possui validade fiscal.',
    };
  }

  async cancelInvoice(
    clinicId: string,
    user: FiscalUser,
    invoiceId: string,
    dto: CancelInvoiceDto,
  ) {
    this.assertOwner(user);
    const invoice = await this.assertInvoiceAccess(clinicId, invoiceId);
    if (invoice.status === ServiceInvoiceStatus.CANCELED) {
      return invoice;
    }
    if (invoice.status === ServiceInvoiceStatus.ISSUED) {
      throw new BadRequestException(
        'Cancelamento de nota emitida por provedor real ainda não está disponível.',
      );
    }

    const updated = await this.prisma.serviceInvoice.update({
      where: { id: invoice.id },
      data: {
        status: ServiceInvoiceStatus.CANCELED,
        cancellationReason: dto.reason,
        canceledAt: new Date(),
        updatedByUserId: user.id,
        isLegalDocument: false,
      },
    });

    await this.createEvent(
      invoice.id,
      'INTERNAL_CANCEL',
      invoice.status,
      updated.status,
      user.id,
      { reason: dto.reason, legalValidity: false },
    );
    return updated;
  }

  async listAppointmentsForInvoice(clinicId: string, query: ListAppointmentsForInvoiceDto) {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit = query.limit && query.limit > 0 ? Math.min(query.limit, 50) : 20;

    const where: Prisma.AppointmentWhereInput = {
      clinicId,
      status: { not: AppointmentStatus.CANCELED },
      ...(query.patient?.trim()
        ? { patientName: { contains: query.patient.trim(), mode: 'insensitive' } }
        : {}),
      ...(query.profileId ? { profileId: query.profileId } : {}),
      ...(query.paymentStatus ? { paymentStatus: query.paymentStatus } : {}),
      ...this.appointmentDateRangeFilter(query.from, query.to),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.appointment.findMany({
        where,
        orderBy: [{ appointmentDate: 'desc' }, { startTime: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          patientName: true,
          patientEmail: true,
          patientPhone: true,
          appointmentDate: true,
          startTime: true,
          status: true,
          paymentStatus: true,
          estimatedAmountCents: true,
          paidAmountCents: true,
          profile: { select: { id: true, displayName: true } },
          service: { select: { id: true, name: true } },
          serviceInvoices: {
            where: { status: { not: ServiceInvoiceStatus.CANCELED } },
            select: { id: true, status: true },
            take: 1,
          },
        },
      }),
      this.prisma.appointment.count({ where }),
    ]);

    const data = rows.map(({ serviceInvoices, ...appt }) => ({
      ...appt,
      hasActiveInvoice: serviceInvoices.length > 0,
      activeInvoiceId: serviceInvoices[0]?.id ?? null,
    }));

    return { data, total, page, limit };
  }

  async getAppointmentInvoiceDraft(clinicId: string, appointmentId: string) {
    const appointment = await this.prisma.appointment.findFirst({
      where: { id: appointmentId, clinicId },
      include: {
        profile: { select: { id: true, displayName: true } },
        service: { select: { id: true, name: true } },
      },
    });

    if (!appointment) {
      throw new NotFoundException('Consulta não encontrada.');
    }

    const existingInvoice = await this.prisma.serviceInvoice.findFirst({
      where: {
        appointmentId,
        clinicId,
        status: { not: ServiceInvoiceStatus.CANCELED },
      },
      select: { id: true, status: true },
    });

    const amountCents =
      appointment.paidAmountCents ?? appointment.estimatedAmountCents ?? 0;
    const paymentPending =
      appointment.paymentStatus === AppointmentPaymentStatus.PAYMENT_PENDING;

    const draft = {
      appointmentId: appointment.id,
      customerName: appointment.patientName,
      customerEmail: appointment.patientEmail ?? undefined,
      customerPhone: appointment.patientPhone ?? undefined,
      serviceDescription: appointment.service?.name ?? 'Consulta odontológica',
      amountCents: amountCents > 0 ? amountCents : 0,
      competenceDate: appointment.appointmentDate.toISOString().slice(0, 10),
    };

    return {
      draft,
      appointment: {
        id: appointment.id,
        patientName: appointment.patientName,
        appointmentDate: appointment.appointmentDate.toISOString().slice(0, 10),
        profileDisplayName: appointment.profile.displayName,
        serviceName: appointment.service?.name ?? null,
        paymentStatus: appointment.paymentStatus,
        estimatedAmountCents: appointment.estimatedAmountCents,
        paidAmountCents: appointment.paidAmountCents,
      },
      existingInvoice,
      warnings: {
        paymentPending,
        hasExistingInvoice: !!existingInvoice,
      },
    };
  }

  async getInvoicePdf(_clinicId: string, _invoiceId: string) {
    throw new NotImplementedException(
      'PDF fiscal real ainda não está disponível. Documento sem validade fiscal.',
    );
  }

  async getInvoiceXml(_clinicId: string, _invoiceId: string) {
    throw new NotImplementedException(
      'XML fiscal real ainda não está disponível. Documento sem validade fiscal.',
    );
  }

  private async assertInvoiceAccess(clinicId: string, invoiceId: string) {
    const invoice = await this.prisma.serviceInvoice.findFirst({
      where: { id: invoiceId, clinicId },
    });
    if (!invoice) throw new NotFoundException('Nota fiscal não encontrada.');
    return invoice;
  }

  private assertOwner(user: FiscalUser) {
    if (user.role !== UserRole.OWNER) {
      throw new ForbiddenException(
        'Você não tem permissão para executar esta ação fiscal.',
      );
    }
  }

  private assertEditable(status: ServiceInvoiceStatus) {
    if (!EDITABLE_STATUSES.includes(status)) {
      throw new BadRequestException(
        'Esta nota fiscal não pode mais ser editada.',
      );
    }
  }

  private async assertReadyForIssue(clinicId: string, invoiceId: string) {
    const profile = await this.prisma.clinicFiscalProfile.findUnique({
      where: { clinicId },
    });
    const invoice = await this.prisma.serviceInvoice.findFirst({
      where: { id: invoiceId, clinicId },
    });

    if (!profile?.isConfigured) {
      throw new BadRequestException(
        'Configure os dados fiscais da clínica antes de continuar.',
      );
    }
    if (!invoice) throw new NotFoundException('Nota fiscal não encontrada.');
    if (!invoice.customerName.trim()) {
      throw new BadRequestException('Nome do cliente é obrigatório.');
    }
    if (
      invoice.customerDocument &&
      !this.isValidCpfOrCnpj(invoice.customerDocument)
    ) {
      throw new BadRequestException('CPF/CNPJ do cliente inválido.');
    }
    if (!invoice.serviceDescription.trim()) {
      throw new BadRequestException('Descrição do serviço é obrigatória.');
    }
    if (invoice.amountCents <= 0) {
      throw new BadRequestException('O valor da nota deve ser maior que zero.');
    }
    if (!invoice.competenceDate) {
      throw new BadRequestException('Data de competência é obrigatória.');
    }
    if (profile.serviceCode && !invoice.serviceCode) {
      throw new BadRequestException('Código de serviço é obrigatório.');
    }
  }

  private async assertLinksBelongToClinic(
    clinicId: string,
    dto: Pick<CreateServiceInvoiceDto, 'appointmentId' | 'patientId'>,
  ) {
    if (dto.appointmentId) {
      const appointment = await this.prisma.appointment.findFirst({
        where: { id: dto.appointmentId, clinicId },
      });
      if (!appointment) {
        throw new BadRequestException('Atendimento vinculado inválido.');
      }
    }

    if (dto.patientId) {
      // Patients are global PATIENT-role users (clinicId === null), mirroring
      // AppointmentsService.assertPatientUser. Scoping the lookup by role (and
      // active/not-deleted) prevents linking an arbitrary user — e.g. another
      // clinic's owner or a platform admin — as the invoice's patient.
      const patient = await this.prisma.user.findFirst({
        where: {
          id: dto.patientId,
          role: UserRole.PATIENT,
          isActive: true,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!patient) {
        throw new BadRequestException('Paciente vinculado inválido.');
      }
    }
  }

  private async createEvent(
    serviceInvoiceId: string,
    eventType: string,
    previousStatus: ServiceInvoiceStatus | null,
    nextStatus: ServiceInvoiceStatus | null,
    createdByUserId?: string,
    metadata?: Record<string, unknown>,
  ) {
    await this.prisma.fiscalInvoiceEvent.create({
      data: {
        serviceInvoiceId,
        eventType,
        previousStatus,
        nextStatus,
        createdByUserId,
        metadata: metadata as Prisma.InputJsonValue | undefined,
      },
    });
  }

  private isFiscalProfileConfigured(dto: UpsertFiscalProfileDto) {
    const required = [
      dto.legalName,
      dto.documentNumber,
      dto.taxRegime,
      dto.addressStreet,
      dto.addressNumber,
      dto.addressNeighborhood,
      dto.addressCity,
      dto.addressState,
      dto.addressZipCode,
    ];

    return (
      required.every((value) => String(value ?? '').trim().length > 0) &&
      this.isValidCpfOrCnpj(dto.documentNumber)
    );
  }

  private competenceDateRange(from?: string, to?: string) {
    const range: Prisma.DateTimeFilter = {};
    if (from) range.gte = this.dateOnly(from);
    if (to) range.lte = this.dateOnly(to);
    return Object.keys(range).length > 0 ? { competenceDate: range } : {};
  }

  private appointmentDateRangeFilter(from?: string, to?: string) {
    const range: Prisma.DateTimeFilter = {};
    if (from) range.gte = this.dateOnly(from);
    if (to) range.lte = this.dateOnly(to);
    return Object.keys(range).length > 0 ? { appointmentDate: range } : {};
  }

  private dateOnly(value: string) {
    return new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  }

  private calculateIssCents(amountCents: number, issRate?: number | null) {
    if (issRate === undefined || issRate === null) return null;
    return Math.round(amountCents * (Number(issRate) / 100));
  }

  private onlyDigits(value: string) {
    return value.replace(/\D/g, '');
  }

  private isValidCpfOrCnpj(value: string) {
    const digits = this.onlyDigits(value);
    if (digits.length === 11) return this.isValidCpf(digits);
    if (digits.length === 14) return this.isValidCnpj(digits);
    return false;
  }

  private isValidCpf(cpf: string) {
    if (/^(\d)\1+$/.test(cpf)) return false;
    const calc = (factor: number) => {
      let total = 0;
      for (let i = 0; i < factor - 1; i += 1) {
        total += Number(cpf[i]) * (factor - i);
      }
      const rest = (total * 10) % 11;
      return rest === 10 ? 0 : rest;
    };
    return calc(10) === Number(cpf[9]) && calc(11) === Number(cpf[10]);
  }

  private isValidCnpj(cnpj: string) {
    if (/^(\d)\1+$/.test(cnpj)) return false;
    const calc = (base: string, factors: number[]) => {
      const total = factors.reduce(
        (sum, factor, index) => sum + Number(base[index]) * factor,
        0,
      );
      const rest = total % 11;
      return rest < 2 ? 0 : 11 - rest;
    };
    const first = calc(cnpj.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    const second = calc(cnpj.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
    return first === Number(cnpj[12]) && second === Number(cnpj[13]);
  }
}
