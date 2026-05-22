import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { MAX_ID_LENGTH } from '../../../common/validators/input-validation.decorators';
import { CreateLeadDto } from './create-lead.dto';
import { UpdateLeadDto } from './update-lead.dto';
import { ListLeadsDto } from './list-leads.dto';
import { CreatePublicLeadDto } from '../../public-leads/dto/create-public-lead.dto';

async function validateDto<T extends object>(
  cls: new () => T,
  payload: Record<string, unknown>,
) {
  return validate(plainToInstance(cls, payload));
}

describe('leads DTO validation', () => {
  describe('serviceId safety in CreateLeadDto', () => {
    it('rejects path-traversal characters in serviceId', async () => {
      const errors = await validateDto(CreateLeadDto, {
        name: 'Maria',
        serviceId: '../admin',
      });
      expect(errors.some((e) => e.property === 'serviceId')).toBe(true);
    });

    it('rejects serviceId longer than MAX_ID_LENGTH', async () => {
      const errors = await validateDto(CreateLeadDto, {
        name: 'Maria',
        serviceId: 'a'.repeat(MAX_ID_LENGTH + 1),
      });
      expect(errors.some((e) => e.property === 'serviceId')).toBe(true);
    });

    it('accepts a valid serviceId', async () => {
      const errors = await validateDto(CreateLeadDto, {
        name: 'Maria',
        serviceId: 'service-1',
      });
      expect(errors.some((e) => e.property === 'serviceId')).toBe(false);
    });
  });

  describe('assignedToUserId safety in CreateLeadDto', () => {
    it('rejects path-traversal characters in assignedToUserId', async () => {
      const errors = await validateDto(CreateLeadDto, {
        name: 'Maria',
        assignedToUserId: '../users',
      });
      expect(errors.some((e) => e.property === 'assignedToUserId')).toBe(true);
    });

    it('rejects assignedToUserId longer than MAX_ID_LENGTH', async () => {
      const errors = await validateDto(CreateLeadDto, {
        name: 'Maria',
        assignedToUserId: 'a'.repeat(MAX_ID_LENGTH + 1),
      });
      expect(errors.some((e) => e.property === 'assignedToUserId')).toBe(true);
    });
  });

  describe('serviceId safety in UpdateLeadDto', () => {
    it('rejects path-traversal characters in serviceId', async () => {
      const errors = await validateDto(UpdateLeadDto, {
        serviceId: '../../etc/passwd',
      });
      expect(errors.some((e) => e.property === 'serviceId')).toBe(true);
    });

    it('rejects serviceId longer than MAX_ID_LENGTH', async () => {
      const errors = await validateDto(UpdateLeadDto, {
        serviceId: 'a'.repeat(MAX_ID_LENGTH + 1),
      });
      expect(errors.some((e) => e.property === 'serviceId')).toBe(true);
    });
  });

  describe('assignedToUserId safety in UpdateLeadDto', () => {
    it('rejects path-traversal characters in assignedToUserId', async () => {
      const errors = await validateDto(UpdateLeadDto, {
        assignedToUserId: '../users',
      });
      expect(errors.some((e) => e.property === 'assignedToUserId')).toBe(true);
    });
  });

  describe('ListLeadsDto', () => {
    it('rejects search longer than 100 characters', async () => {
      const errors = await validateDto(ListLeadsDto, {
        search: 'a'.repeat(101),
      });
      expect(errors.some((e) => e.property === 'search')).toBe(true);
    });

    it('accepts search at exactly 100 characters (boundary)', async () => {
      const errors = await validateDto(ListLeadsDto, {
        search: 'a'.repeat(100),
      });
      expect(errors.some((e) => e.property === 'search')).toBe(false);
    });

    it('rejects unsafe characters in assignedToUserId filter', async () => {
      const errors = await validateDto(ListLeadsDto, {
        assignedToUserId: 'user/1',
      });
      expect(errors.some((e) => e.property === 'assignedToUserId')).toBe(true);
    });

    it('rejects assignedToUserId filter longer than MAX_ID_LENGTH', async () => {
      const errors = await validateDto(ListLeadsDto, {
        assignedToUserId: 'a'.repeat(MAX_ID_LENGTH + 1),
      });
      expect(errors.some((e) => e.property === 'assignedToUserId')).toBe(true);
    });
  });

  describe('CreatePublicLeadDto acceptedPrivacyPolicy', () => {
    it('rejects acceptedPrivacyPolicy = false', async () => {
      const errors = await validateDto(CreatePublicLeadDto, {
        name: 'João Silva',
        phone: '11987654321',
        acceptedPrivacyPolicy: false,
      });
      expect(errors.some((e) => e.property === 'acceptedPrivacyPolicy')).toBe(true);
    });

    it('accepts acceptedPrivacyPolicy = true', async () => {
      const errors = await validateDto(CreatePublicLeadDto, {
        name: 'João Silva',
        phone: '11987654321',
        acceptedPrivacyPolicy: true,
      });
      expect(errors.some((e) => e.property === 'acceptedPrivacyPolicy')).toBe(false);
    });
  });
});
