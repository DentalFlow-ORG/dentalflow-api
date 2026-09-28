import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { UpdateClinicProfileDto } from './update-clinic-profile.dto';

async function check(payload: Record<string, unknown>) {
  const instance = plainToInstance(UpdateClinicProfileDto, payload);
  const errors = await validate(instance);
  return { instance, props: errors.map((error) => error.property) };
}

describe('UpdateClinicProfileDto validation', () => {
  it('accepts a masked profile and normalises it', async () => {
    const { props, instance } = await check({
      name: '  Odonto Saúde ',
      email: ' Contato@Clinica.COM.br ',
      phone: '(61) 3333-4444',
      websiteUrl: 'https://www.clinica.com.br',
      state: 'df',
      postalCode: '70000-000',
    });

    expect(props).toEqual([]);
    expect(instance).toMatchObject({
      name: 'Odonto Saúde',
      email: 'contato@clinica.com.br',
      phone: '6133334444',
      state: 'DF',
      postalCode: '70000000',
    });
  });

  it.each([
    ['name', '   '],
    ['name', 'A'],
    ['name', 'a'.repeat(101)],
    ['name', null],
    ['email', 'contato@'],
    ['phone', '1234'],
    ['state', 'XX'],
    ['postalCode', '7000-000'],
    ['websiteUrl', 'javascript:alert(1)'],
    ['websiteUrl', 'ftp://clinica.com.br'],
    ['websiteUrl', 'www.clinica.com.br'],
    ['addressLine1', 'a'.repeat(201)],
    ['city', 'a'.repeat(101)],
  ])('rejects %s = %j', async (field, value) => {
    const { props } = await check({ [field]: value });
    expect(props).toContain(field);
  });

  it('accepts an http website as well as https', async () => {
    const { props } = await check({ websiteUrl: 'http://clinica.com.br' });
    expect(props).toEqual([]);
  });

  it.each([
    'email',
    'phone',
    'websiteUrl',
    'addressLine1',
    'addressLine2',
    'city',
    'state',
    'postalCode',
  ])('clears %s with null or a blank string', async (field) => {
    const fromNull = await check({ [field]: null });
    const fromBlank = await check({ [field]: '  ' });

    expect(fromNull.props).toEqual([]);
    expect(fromBlank.props).toEqual([]);
    expect(
      (fromNull.instance as unknown as Record<string, unknown>)[field],
    ).toBeNull();
    expect(
      (fromBlank.instance as unknown as Record<string, unknown>)[field],
    ).toBeNull();
  });

  it('leaves absent fields undefined (unchanged)', async () => {
    const { instance } = await check({ name: 'Odonto Saúde' });
    expect(instance.email).toBeUndefined();
    expect(instance.phone).toBeUndefined();
  });
});
