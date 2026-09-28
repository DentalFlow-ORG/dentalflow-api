import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PatientIdentityService } from './patient-identity.service';
import { PrismaService } from '../../prisma/prisma.service';
import { toCanonicalBrazilianPhone } from '../utils/transform.helpers';
import {
  isEmailIdentifier,
  patientIdentityFilter,
  normalizePatientEmail,
  normalizePatientName,
} from '../utils/patient-identity';

/** Prisma client or an open transaction; both expose the patient delegate. */
type PatientDb = Pick<PrismaService, 'patient'>;

/**
 * The single place a patient identity is decided.
 *
 * `Patient.id` is identity. Name, email and phone are attributes: two different
 * people may legitimately share all three, and one person may change any of
 * them without becoming a different patient. Nothing outside this service may
 * turn contact details into an identity, which is what made the previous model
 * able to overwrite one patient's dental chart while charting another.
 *
 * Identity is asserted by the operator, not inferred:
 *
 *   - a caller that knows the patient sends `patientId`, and it is validated
 *     against the caller's clinic;
 *   - a caller that does not is served by an explicitly bounded compatibility
 *     path (`resolveLegacyIdentifier`) that reuses a patient only when exactly
 *     one matches, and never creates one;
 *   - creating a patient is a separate, deliberate call.
 *
 * The compatibility path exists only until every client sends `patientId`.
 * Compatibility never lets a contact predicate directly select stable-owned rows.
 */
@Injectable()
export class PatientResolverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly legacyIdentity: PatientIdentityService,
  ) {}

  /** Explicit IDs are authoritative; conflicting contact assertions fail closed. */
  async resolveReference(
    clinicId: string,
    identifier: string,
    patientId?: string,
  ) {
    if (patientId) {
      const patient = await this.requirePatient(clinicId, patientId);
      const expected =
        normalizePatientEmail(patient.email) ??
        patient.name.trim().toLowerCase();
      if (identifier.trim().toLowerCase() !== expected) {
        throw new ConflictException(
          'O identificador informado não corresponde ao paciente selecionado.',
        );
      }
      return { id: patient.id };
    }
    await this.legacyIdentity.assertUnambiguousIdentity(clinicId, identifier);
    return this.resolveLegacyIdentifier(clinicId, identifier);
  }

  /** Legacy matching can never select an already-owned row directly. */
  async scopeWhere(clinicId: string, identifier: string, patientId?: string) {
    const patient = await this.resolveReference(
      clinicId,
      identifier,
      patientId,
    );
    return patient
      ? { patientId: patient.id }
      : { patientId: null, ...patientIdentityFilter(identifier) };
  }

  /**
   * Loads a patient by id, scoped to the clinic.
   *
   * The clinic filter is part of the lookup rather than a check afterwards, so
   * a patient id belonging to another tenant is indistinguishable from one
   * that does not exist.
   */
  async requirePatient(
    clinicId: string,
    patientId: string,
    tx: PatientDb = this.prisma,
  ) {
    const patient = await tx.patient.findFirst({
      where: { id: patientId, clinicId, deletedAt: null },
    });

    if (!patient) {
      throw new NotFoundException('Paciente não encontrado.');
    }

    return patient;
  }

  /**
   * Resolves a legacy name-or-email identifier to an existing patient.
   *
   * Returns null when nothing matches — callers must not treat that as
   * permission to invent an identity. Throws when more than one patient
   * matches, because choosing between them is exactly the guess that
   * corrupted clinical data before.
   */
  async resolveLegacyIdentifier(
    clinicId: string,
    identifier: string,
    tx: PatientDb = this.prisma,
  ): Promise<{ id: string } | null> {
    const email = isEmailIdentifier(identifier)
      ? normalizePatientEmail(identifier)
      : null;
    const name = normalizePatientName(identifier);

    // An identifier is either an address or a name, never both. `where`
    // mirrors the legacy rule: match the address when there is one, otherwise
    // match the name among patients that have no address on file.
    const where: Prisma.PatientWhereInput = email
      ? {
          clinicId,
          deletedAt: null,
          email: { equals: email, mode: 'insensitive' },
        }
      : {
          clinicId,
          deletedAt: null,
          email: null,
          name: { equals: name ?? '', mode: 'insensitive' },
        };

    // Two rows are enough to prove ambiguity; there is no reason to load more.
    const matches = await tx.patient.findMany({
      where,
      select: { id: true },
      take: 2,
    });

    if (matches.length === 0) return null;

    if (matches.length > 1) {
      throw new ConflictException(
        'Mais de um paciente corresponde a estes dados de contato. ' +
          'Selecione o paciente correto para continuar.',
      );
    }

    return matches[0];
  }

  /**
   * Creates a patient. Only call this where the operator's intent to record a
   * new person is explicit; never as a fallback for a lookup that found
   * nothing, and never inside a retry path that could run twice.
   */
  async createPatient(
    clinicId: string,
    data: { name: string; email?: string | null; phone?: string | null },
    tx: PatientDb = this.prisma,
  ) {
    return tx.patient.create({
      data: {
        clinicId,
        name: normalizePatientName(data.name) ?? data.name,
        email: normalizePatientEmail(data.email),
        // Digits only, like appointment/user/clinic phones. A value that is not
        // a recognisable Brazilian number is kept as given rather than lost.
        // The phone is a contact attribute, never an identity key.
        phone: data.phone
          ? (toCanonicalBrazilianPhone(data.phone) ?? data.phone)
          : null,
      },
    });
  }
}
