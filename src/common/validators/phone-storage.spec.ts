import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import {
  normalizePhoneSnapshot,
  blankToNullPhone,
} from '../utils/transform.helpers';
import { CreateAppointmentDto } from '../../modules/appointments/dto/create-appointment.dto';
import { UpdateAppointmentDto } from '../../modules/appointments/dto/update-appointment.dto';
import { CreateClinicalRecordDto } from '../../modules/clinical-records/dto/create-clinical-record.dto';
import { UpdateClinicalRecordDto } from '../../modules/clinical-records/dto/update-clinical-record.dto';
import {
  CreateServiceInvoiceDto,
  UpdateServiceInvoiceDto,
} from '../../modules/fiscal/dto/invoice.dto';
import { UpdateClinicProfileDto } from '../../modules/clinic/dto/update-clinic-profile.dto';
import { AdminUpdateUserDto } from '../../modules/users/dto/admin-update-user.dto';

describe('phone storage DTO boundary', () => {
  const cases: [new () => object, string][] = [
    [CreateAppointmentDto, 'patientPhone'],
    [UpdateAppointmentDto, 'patientPhone'],
    [CreateClinicalRecordDto, 'patientPhone'],
    [UpdateClinicalRecordDto, 'patientPhone'],
    [CreateServiceInvoiceDto, 'customerPhone'],
    [UpdateServiceInvoiceDto, 'customerPhone'],
    [UpdateClinicProfileDto, 'phone'],
    [AdminUpdateUserDto, 'phone'],
  ];
  it.each(cases)(
    '%p normalizes the contact attribute %s, preserving explicit identity',
    (Dto, field) => {
      const instance = plainToInstance(Dto, {
        [field]: '+55 (61) 99999-9999',
        patientId: 'patient-B',
      });
      expect(instance).toMatchObject({
        [field]: '61999999999',
        patientId: 'patient-B',
      });
    },
  );
  it('retains unrecognised legacy snapshots without turning contacts into identifiers', () => {
    expect(normalizePhoneSnapshot('contato legado')).toBe('contato legado');
    expect(normalizePhoneSnapshot(null)).toBeNull();
    expect(normalizePhoneSnapshot(undefined)).toBeUndefined();
  });
  it('distinguishes clear from omission for nullable phone updates', () => {
    expect(blankToNullPhone(' ')).toBeNull();
    expect(blankToNullPhone(null)).toBeNull();
    expect(blankToNullPhone(undefined)).toBeUndefined();
    expect(blankToNullPhone('0055 (55) 99999-9999')).toBe('55999999999');
  });
});
