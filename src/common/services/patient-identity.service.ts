import { ConflictException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  isEmailIdentifier,
  normalizePatientEmail,
  normalizePatientName,
} from '../utils/patient-identity';

/**
 * Guards the patient-identity cases that cannot be resolved safely.
 *
 * Neither identifier branch identifies a person:
 *
 *   - a name-only identifier collapses two people who share a name and have no
 *     email on file;
 *   - an email identifier collapses a household that books several people
 *     under one shared address, which is ordinary clinic behaviour.
 *
 * Either way one patient's clinical record or dental chart can surface — or be
 * overwritten — under the other's identity.
 *
 * Each branch is checked against the field the other branch keys on, using
 * exact equality after normalization. No fuzzy or similarity matching is
 * performed:
 *
 *   - name-only identifiers are checked against distinct appointment phone
 *     numbers, compared on digits alone (`CreateAppointmentDto.patientPhone`
 *     is required, so the signal is always available for new bookings);
 *   - email identifiers are checked against distinct patient names, compared
 *     after trimming and lower-casing.
 *
 * When a signal fires, clinical reads and writes fail loudly instead of
 * merging. Refusing to answer is recoverable; silently attributing one
 * patient's clinical data to another is not. The same signal also fires for a
 * single patient whose phone or name was recorded inconsistently; that false
 * positive is deliberate, because the stored data genuinely cannot distinguish
 * the two situations.
 *
 * This is containment, not a fix, and it is not complete: two people sharing
 * both a name and an email — or a name and a phone — remain indistinguishable,
 * because these columns do not identify a person. The durable fix is a stable
 * Patient entity; see docs/deployment/patient-identity-design.md.
 */
@Injectable()
export class PatientIdentityService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Distinct phone numbers recorded against a name-only patient identity.
   * Returns 0 when the clinic has no appointment for that name.
   */
  async countNameOnlyIdentityPhones(
    clinicId: string,
    name: string,
  ): Promise<number> {
    const normalizedName = normalizePatientName(name);
    if (!normalizedName) return 0;

    const rows = await this.prisma.appointment.findMany({
      where: {
        clinicId,
        patientName: { equals: normalizedName, mode: 'insensitive' },
        patientEmail: null,
      },
      select: { patientPhone: true },
      distinct: ['patientPhone'],
    });

    // Compare on digits only: "(11) 99999-0000" and "11999990000" are one
    // normalized phone value; this does not prove that the person is the same.
    const phones = new Set(
      rows
        .map((row) => (row.patientPhone ?? '').replace(/\D/g, ''))
        .filter((phone) => phone.length > 0),
    );

    return phones.size;
  }

  /**
   * Distinct patient names recorded against one email address.
   * Returns 0 when the clinic has no appointment for that address.
   */
  async countSharedEmailIdentityNames(
    clinicId: string,
    email: string,
  ): Promise<number> {
    const normalizedEmail = normalizePatientEmail(email);
    if (!normalizedEmail) return 0;

    const rows = await this.prisma.appointment.findMany({
      where: {
        clinicId,
        patientEmail: { equals: normalizedEmail, mode: 'insensitive' },
      },
      select: { patientName: true },
      distinct: ['patientName'],
    });

    // Compare on the normalized name: "Maria Silva" and " maria silva " are
    // one person entered twice, not two people.
    const names = new Set(
      rows
        .map((row) => normalizePatientName(row.patientName)?.toLowerCase())
        .filter((name): name is string => Boolean(name)),
    );

    return names.size;
  }

  /**
   * True when the identifier is known to cover more than one person.
   * Each branch is checked against the field the other branch keys on.
   */
  async isAmbiguousIdentity(
    clinicId: string,
    identifier: string,
  ): Promise<boolean> {
    if (isEmailIdentifier(identifier)) {
      return (
        (await this.countSharedEmailIdentityNames(clinicId, identifier)) > 1
      );
    }
    return (await this.countNameOnlyIdentityPhones(clinicId, identifier)) > 1;
  }

  /**
   * Throws when the identifier cannot be attributed to a single patient.
   * Call before reading or writing any clinical data keyed by identifier.
   */
  async assertUnambiguousIdentity(
    clinicId: string,
    identifier: string,
  ): Promise<void> {
    if (!(await this.isAmbiguousIdentity(clinicId, identifier))) return;

    throw new ConflictException(
      isEmailIdentifier(identifier)
        ? 'Mais de um paciente foi registrado com este e-mail. Para proteger ' +
            'o histórico clínico, cadastre um e-mail distinto em cada paciente ' +
            'antes de acessar estes dados.'
        : 'Mais de um paciente foi registrado com este nome e sem e-mail. ' +
            'Para proteger o histórico clínico, cadastre um e-mail distinto em ' +
            'cada paciente antes de acessar estes dados.',
    );
  }
}
