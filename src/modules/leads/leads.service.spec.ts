import 'reflect-metadata';
import {
  BadRequestException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import { LeadsService } from './leads.service';

const txMock = {
  lead: { update: jest.fn() },
  leadActivity: { create: jest.fn() },
};

const prismaMock = {
  lead: {
    findFirst: jest.fn(),
    create: jest.fn(),
    findMany: jest.fn(),
    count: jest.fn(),
  },
  leadActivity: {
    create: jest.fn(),
    findMany: jest.fn(),
  },
  service: { findFirst: jest.fn() },
  user: { findFirst: jest.fn() },
  profile: { findFirst: jest.fn() },
  subscription: { findUnique: jest.fn() },
  $transaction: jest.fn((cb: (tx: typeof txMock) => unknown) => cb(txMock)),
};

const auditLogMock = { log: jest.fn() };

function makeService() {
  return new LeadsService(prismaMock as never, auditLogMock as never);
}

const CLINIC_ID = 'clinic-1';
const USER_ID = 'user-1';
const LEAD_ID = 'lead-1';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('LeadsService', () => {
  describe('assertLeadInClinic', () => {
    it('throws NotFoundException when lead does not belong to clinic', async () => {
      prismaMock.lead.findFirst.mockResolvedValue(null);

      await expect(
        makeService().findById(CLINIC_ID, LEAD_ID),
      ).rejects.toThrow(NotFoundException);
    });

    it('returns lead when it belongs to the clinic', async () => {
      const lead = { id: LEAD_ID, status: 'NEW' };
      prismaMock.lead.findFirst.mockResolvedValue(lead);

      await expect(
        makeService().findById(CLINIC_ID, LEAD_ID),
      ).resolves.toEqual(lead);
    });
  });

  describe('createLead', () => {
    it('throws UnprocessableEntityException when clinic has no profile', async () => {
      prismaMock.subscription.findUnique.mockResolvedValue(null);
      prismaMock.profile.findFirst.mockResolvedValue(null);

      await expect(
        makeService().createLead(CLINIC_ID, USER_ID, { name: 'Ana' } as never),
      ).rejects.toThrow(UnprocessableEntityException);
    });

    it('throws NotFoundException when serviceId does not belong to clinic', async () => {
      prismaMock.subscription.findUnique.mockResolvedValue(null);
      prismaMock.profile.findFirst.mockResolvedValue({ id: 'profile-1' });
      prismaMock.service.findFirst.mockResolvedValue(null);

      await expect(
        makeService().createLead(CLINIC_ID, USER_ID, {
          name: 'Ana',
          serviceId: 'other-clinic-service',
        } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when assignedToUserId does not belong to clinic', async () => {
      prismaMock.subscription.findUnique.mockResolvedValue(null);
      prismaMock.profile.findFirst.mockResolvedValue({ id: 'profile-1' });
      prismaMock.service.findFirst.mockResolvedValue({ id: 'service-1' });
      prismaMock.user.findFirst.mockResolvedValue(null);

      await expect(
        makeService().createLead(CLINIC_ID, USER_ID, {
          name: 'Ana',
          serviceId: 'service-1',
          assignedToUserId: 'other-clinic-user',
        } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it('creates lead when all checks pass', async () => {
      prismaMock.subscription.findUnique.mockResolvedValue(null);
      prismaMock.profile.findFirst.mockResolvedValue({ id: 'profile-1' });
      const created = { id: LEAD_ID, name: 'Ana', clinicId: CLINIC_ID };
      prismaMock.lead.create.mockResolvedValue(created);

      await expect(
        makeService().createLead(CLINIC_ID, USER_ID, { name: 'Ana' } as never),
      ).resolves.toEqual(created);
    });

    it('throws UnprocessableEntityException when monthly lead quota is exceeded', async () => {
      prismaMock.subscription.findUnique.mockResolvedValue({
        plan: { maxLeadsPerMonth: 10 },
      });
      prismaMock.lead.count.mockResolvedValue(10);

      await expect(
        makeService().createLead(CLINIC_ID, USER_ID, { name: 'Ana' } as never),
      ).rejects.toThrow(UnprocessableEntityException);
    });
  });

  describe('updateLeadStatus', () => {
    it('throws BadRequestException when new status equals current status', async () => {
      prismaMock.lead.findFirst.mockResolvedValue({ id: LEAD_ID, status: 'NEW' });

      await expect(
        makeService().updateLeadStatus(CLINIC_ID, USER_ID, LEAD_ID, {
          status: 'NEW',
        } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('transitions status and creates activity', async () => {
      prismaMock.lead.findFirst.mockResolvedValue({ id: LEAD_ID, status: 'NEW' });
      const updated = { id: LEAD_ID, status: 'CONTACTED' };
      txMock.lead.update.mockResolvedValue(updated);
      txMock.leadActivity.create.mockResolvedValue({});

      await expect(
        makeService().updateLeadStatus(CLINIC_ID, USER_ID, LEAD_ID, {
          status: 'CONTACTED',
        } as never),
      ).resolves.toEqual(updated);

      expect(txMock.leadActivity.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'STATUS_CHANGED',
            oldStatus: 'NEW',
            newStatus: 'CONTACTED',
          }),
        }),
      );
    });
  });

  describe('addActivity', () => {
    it('throws BadRequestException when NOTE_ADDED has no note', async () => {
      prismaMock.lead.findFirst.mockResolvedValue({ id: LEAD_ID, status: 'NEW' });

      await expect(
        makeService().addActivity(CLINIC_ID, USER_ID, LEAD_ID, {
          action: 'NOTE_ADDED',
          note: '   ',
        } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('creates activity when note is present for NOTE_ADDED', async () => {
      prismaMock.lead.findFirst.mockResolvedValue({ id: LEAD_ID, status: 'NEW' });
      const activity = { id: 'act-1', action: 'NOTE_ADDED' };
      prismaMock.leadActivity.create.mockResolvedValue(activity);

      await expect(
        makeService().addActivity(CLINIC_ID, USER_ID, LEAD_ID, {
          action: 'NOTE_ADDED',
          note: 'Deixar mensagem amanhã',
        } as never),
      ).resolves.toEqual(activity);
    });
  });

  describe('convertLead', () => {
    it('throws UnprocessableEntityException when lead is already CONVERTED', async () => {
      prismaMock.lead.findFirst.mockResolvedValue({ id: LEAD_ID, status: 'CONVERTED' });

      await expect(
        makeService().convertLead(CLINIC_ID, USER_ID, LEAD_ID),
      ).rejects.toThrow(UnprocessableEntityException);
    });
  });

  describe('archiveLead', () => {
    it('throws BadRequestException when lead is already ARCHIVED', async () => {
      prismaMock.lead.findFirst.mockResolvedValue({ id: LEAD_ID, status: 'ARCHIVED' });

      await expect(
        makeService().archiveLead(CLINIC_ID, USER_ID, LEAD_ID),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
