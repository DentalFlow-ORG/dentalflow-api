import {
  isEmailIdentifier,
  normalizePatientEmail,
  normalizePatientEmailForWrite,
  normalizePatientName,
  patientIdentifierFor,
  patientIdentityFilter,
  patientIdentityKey,
} from './patient-identity';

describe('patient identity', () => {
  describe('normalizePatientEmail', () => {
    it('lower-cases and trims so one patient keeps one identity', () => {
      expect(normalizePatientEmail('  Maria@Gmail.COM ')).toBe(
        'maria@gmail.com',
      );
    });

    it('treats blank and whitespace-only values as absent', () => {
      // An empty string stored in patientEmail would become its own identity
      // key and silently split the patient away from their own history.
      expect(normalizePatientEmail('')).toBeNull();
      expect(normalizePatientEmail('   ')).toBeNull();
      expect(normalizePatientEmail(null)).toBeNull();
      expect(normalizePatientEmail(undefined)).toBeNull();
    });
  });

  describe('normalizePatientEmailForWrite', () => {
    it('preserves undefined so a partial update cannot erase the email', () => {
      // Collapsing undefined to null here would wipe the patient's identity on
      // every appointment update that did not resend the email field.
      expect(normalizePatientEmailForWrite(undefined)).toBeUndefined();
    });

    it('normalizes a supplied value and nulls an explicit blank', () => {
      expect(normalizePatientEmailForWrite(' Ana@X.COM ')).toBe('ana@x.com');
      expect(normalizePatientEmailForWrite('')).toBeNull();
      expect(normalizePatientEmailForWrite(null)).toBeNull();
    });
  });

  describe('normalizePatientName', () => {
    it('trims and reports blank names as absent', () => {
      expect(normalizePatientName('  Maria Silva ')).toBe('Maria Silva');
      expect(normalizePatientName('   ')).toBeNull();
      expect(normalizePatientName(undefined)).toBeNull();
    });
  });

  describe('isEmailIdentifier', () => {
    it('recognizes emails regardless of surrounding whitespace', () => {
      expect(isEmailIdentifier(' maria@x.com ')).toBe(true);
    });

    it('treats a plain name as a name identifier', () => {
      expect(isEmailIdentifier('Maria Silva')).toBe(false);
    });
  });

  describe('patientIdentityKey', () => {
    it('collapses case and whitespace variants of one email', () => {
      const key = patientIdentityKey({
        patientEmail: 'Maria@Gmail.com',
        patientName: 'Maria Silva',
      });

      expect(
        patientIdentityKey({
          patientEmail: ' maria@gmail.com ',
          patientName: 'maria silva',
        }),
      ).toBe(key);
    });

    it('does not merge two patients that only share a name spelling', () => {
      expect(
        patientIdentityKey({ patientEmail: 'a@x.com', patientName: 'Maria' }),
      ).not.toBe(
        patientIdentityKey({ patientEmail: 'b@x.com', patientName: 'Maria' }),
      );
    });

    it('falls back to the lower-cased name when there is no email', () => {
      expect(
        patientIdentityKey({
          patientEmail: null,
          patientName: ' Maria Silva ',
        }),
      ).toBe('maria silva');
    });

    it('treats a blank email as no email rather than as its own patient', () => {
      expect(
        patientIdentityKey({ patientEmail: '   ', patientName: 'Maria Silva' }),
      ).toBe('maria silva');
    });
  });

  describe('patientIdentifierFor', () => {
    it('emits the normalized email so clients send back a stable value', () => {
      expect(
        patientIdentifierFor({
          patientEmail: ' Maria@Gmail.com ',
          patientName: 'Maria Silva',
        }),
      ).toBe('maria@gmail.com');
    });

    it('emits the trimmed display name when there is no email', () => {
      expect(
        patientIdentifierFor({
          patientEmail: null,
          patientName: ' Maria Silva ',
        }),
      ).toBe('Maria Silva');
    });
  });

  describe('patientIdentityFilter', () => {
    it('matches an email case-insensitively so legacy rows still resolve', () => {
      expect(patientIdentityFilter(' Maria@Gmail.com ')).toEqual({
        patientEmail: { equals: 'maria@gmail.com', mode: 'insensitive' },
      });
    });

    it('requires a null email on the name branch', () => {
      // Without this, a name lookup would also return rows that belong to the
      // email branch, re-merging patients the email split apart.
      expect(patientIdentityFilter('Maria Silva')).toEqual({
        patientName: { equals: 'Maria Silva', mode: 'insensitive' },
        patientEmail: null,
      });
    });

    it('round-trips the identifier emitted by patientIdentifierFor', () => {
      const patient = {
        patientEmail: 'Maria@Gmail.com',
        patientName: 'Maria Silva',
      };
      const filter = patientIdentityFilter(patientIdentifierFor(patient));

      expect(filter.patientEmail).toEqual({
        equals: 'maria@gmail.com',
        mode: 'insensitive',
      });
    });
  });
});
