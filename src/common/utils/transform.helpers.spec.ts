import {
  blankToNull,
  blankToNullDigits,
  blankToNullNumber,
  blankToUndefined,
  digitsOnly,
  normalizePhone,
  toCanonicalBrazilianPhone,
} from './transform.helpers';

describe('transform helpers', () => {
  describe('digitsOnly / normalizePhone', () => {
    it('keeps only the digits of a masked value', () => {
      expect(digitsOnly('(11) 98765-4321')).toBe('11987654321');
      expect(normalizePhone('01310-100')).toBe('01310100');
    });

    it('passes non-strings through untouched', () => {
      expect(digitsOnly(null)).toBeNull();
      expect(digitsOnly(undefined)).toBeUndefined();
      expect(digitsOnly(42)).toBe(42);
    });
  });

  describe('blankToUndefined', () => {
    it.each(['', '   ', '\n\t'])('treats %j as not provided', (value) => {
      expect(blankToUndefined(value)).toBeUndefined();
    });

    it('trims a real value', () => {
      expect(blankToUndefined('  ana@example.test ')).toBe('ana@example.test');
    });

    it('passes null and non-strings through', () => {
      expect(blankToUndefined(null)).toBeNull();
      expect(blankToUndefined(7)).toBe(7);
    });
  });

  describe('blankToNull', () => {
    it('turns a blank string into null so a PATCH clears the field', () => {
      expect(blankToNull('   ')).toBeNull();
    });

    it('keeps undefined, which means "unchanged"', () => {
      expect(blankToNull(undefined)).toBeUndefined();
    });

    it('trims a real value', () => {
      expect(blankToNull(' Sala 3 ')).toBe('Sala 3');
    });
  });

  describe('blankToNullDigits', () => {
    it('clears on blank and strips the mask otherwise', () => {
      expect(blankToNullDigits(' ')).toBeNull();
      expect(blankToNullDigits('(61) 3333-4444')).toBe('6133334444');
      expect(blankToNullDigits(undefined)).toBeUndefined();
      expect(blankToNullDigits(null)).toBeNull();
    });
  });
});

describe('blankToNullNumber', () => {
  it.each([
    ['', null],
    ['   ', null],
    ['1500', 1500],
    [' 0 ', 0],
    [1500, 1500],
    [null, null],
    [undefined, undefined],
  ])('maps %j to %j', (input, expected) => {
    expect(blankToNullNumber(input)).toBe(expected);
  });

  it('leaves a non-numeric string for the validators to reject', () => {
    expect(blankToNullNumber('abc')).toBe('abc');
  });
});

describe('toCanonicalBrazilianPhone', () => {
  it.each([
    ['(11) 98765-4321', '11987654321'],
    ['(61) 3333-4444', '6133334444'],
    ['11 98765 4321', '11987654321'],
    ['+55 (11) 98765-4321', '11987654321'],
    ['0055 11 98765-4321', '11987654321'],
    ['5511987654321', '11987654321'],
    // DDD 55 (Rio Grande do Sul) is a local number, not a country code.
    ['(55) 99876-5432', '55998765432'],
    ['(55) 3222-1111', '5532221111'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(toCanonicalBrazilianPhone(input)).toBe(expected);
  });

  it.each(['', '123', '(11) 9876-54321-0', '556199998888', 'sem telefone'])(
    'returns null for %j, which is not a recognisable Brazilian number',
    (input) => {
      expect(toCanonicalBrazilianPhone(input)).toBeNull();
    },
  );
});

describe('normalizePhone canonical writes', () => {
  it.each([
    ['+55 (61) 99999-9999', '61999999999'],
    ['0055 (61) 3333-4444', '6133334444'],
    ['(55) 99999-9999', '55999999999'],
    ['(55) 3333-4444', '5533334444'],
  ])(
    'normalizes %s without confusing country code and DDD',
    (raw, expected) => {
      expect(normalizePhone(raw)).toBe(expected);
    },
  );
});
