/**
 * Assigns stable `patientId` to rows that predate the Patient entity.
 *
 * The rule this script exists to enforce is what it does NOT do. Matching
 * name, email or phone is not evidence that two rows describe one person —
 * a household shares an address, partners share a phone, and two people
 * genuinely share a full name. Grouping on those columns is exactly the defect
 * the Patient entity was introduced to remove, and recreating it here would
 * bury it under a new table.
 *
 * So identity is only ever taken from a relationship the database already
 * guarantees:
 *
 *   RECORD_FROM_APPT  a clinical record attached to an appointment inherits
 *                     that appointment's patient, because the link is an FK.
 *                     Records and appointments in different clinics are
 *                     skipped rather than linked across a tenant boundary.
 *
 * Legacy *appointments* are deliberately NOT assigned automatically. Earlier
 * versions grouped them by `patientUserId`, then by `patientUserId` plus the
 * normalized name. Both were wrong for the same reason: an account is not a
 * person and a name is a demographic attribute, so a household login shared by
 * a father and son with the same full name merged two people into one Patient.
 * Legacy identity was never recorded and cannot be recovered by inference.
 *
 * Everything else is left with `patientId = NULL`. That is the quarantine:
 * those rows keep working through the legacy contact-matching path, which
 * still refuses ambiguous lookups, and an operator assigns them later with
 * clinical knowledge the database does not have. Fragmenting one real patient
 * into two provisional rows is recoverable; merging two real people is not.
 *
 * Standalone odontograms are the highest-risk surface — they carry no FK to
 * anything — and are therefore never assigned automatically.
 *
 * Usage:
 *   bun run patients:backfill            report only, changes nothing
 *   bun run patients:backfill --apply    perform the deterministic assignment
 *
 * Refuses to run against a host that is not obviously disposable unless
 * ALLOW_NON_LOCAL_BACKFILL=1 is set, so it cannot be pointed at production by
 * accident.
 */
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { Pool } from 'pg';

const APPLY = process.argv.includes('--apply');

/** Shape the rules report into; also the integration test's assertion target. */
export const emptyCounts = (): Counts => ({
  appointments: { total: 0, assigned: 0, unresolved: 0 },
  clinicalRecords: { total: 0, assigned: 0, unresolved: 0 },
  odontograms: { total: 0, assigned: 0, unresolved: 0 },
  avatars: { total: 0, assigned: 0, unresolved: 0 },
  patientsCreated: 0,
});

export type Counts = {
  appointments: { total: number; assigned: number; unresolved: number };
  clinicalRecords: { total: number; assigned: number; unresolved: number };
  odontograms: { total: number; assigned: number; unresolved: number };
  avatars: { total: number; assigned: number; unresolved: number };
  patientsCreated: number;
};

function assertDisposableTarget(url: string): void {
  if (process.env.ALLOW_NON_LOCAL_BACKFILL === '1') return;

  const host = (() => {
    try {
      // Node keeps the brackets on an IPv6 hostname, and host names are
      // case-insensitive, so normalize both before comparing. An unparseable
      // URL yields '' and is refused.
      return new URL(url).hostname.toLowerCase().replace(/^\[|\]$/g, '');
    } catch {
      return '';
    }
  })();

  const local = ['localhost', '127.0.0.1', '::1', 'host.docker.internal'];
  if (!local.includes(host)) {
    throw new Error(
      `Refusing to run the patient backfill against host "${host}".\n` +
        'This script writes identity columns. Point DATABASE_URL at a ' +
        'disposable or restored copy, or set ALLOW_NON_LOCAL_BACKFILL=1 ' +
        'deliberately once a verified restore exists.',
    );
  }
}

/**
 * Rule RECORD_FROM_APPT — a clinical record linked to an appointment inherits
 * that appointment's patient. The link is a foreign key, so this cannot join
 * two different people.
 */
export async function backfillRecordsFromAppointments(
  prisma: PrismaClient,
  counts: Counts,
  apply = APPLY,
): Promise<void> {
  const linked = await prisma.clinicalRecord.findMany({
    where: {
      patientId: null,
      appointmentId: { not: null },
      appointment: { patientId: { not: null } },
    },
    select: {
      id: true,
      clinicId: true,
      appointmentId: true,
      appointment: {
        select: {
          patientId: true,
          clinicId: true,
          patientRecord: { select: { clinicId: true, deletedAt: true } },
        },
      },
    },
  });

  for (const record of linked) {
    const patientId = record.appointment?.patientId;
    if (!patientId) continue;

    // The write path already refuses to attach a record to another clinic's
    // appointment, but the backfill must not depend on that having always held.
    // A record whose appointment sits in a different clinic is left quarantined
    // rather than given a patient from across a tenant boundary.
    if (
      record.appointment?.clinicId !== record.clinicId ||
      record.appointment.patientRecord?.clinicId !== record.clinicId ||
      record.appointment.patientRecord.deletedAt !== null
    )
      continue;

    if (apply) {
      // Lock every row providing the proof, then revalidate the observed relationship.
      // Reconciliation that committed after the scan is skipped; concurrent writes
      // after this check wait until our assignment commits.
      const updated = await prisma.$transaction(async (tx) => {
        const proof = await tx.$queryRaw<{ id: string }[]>`
          SELECT r.id FROM clinical_records r
          JOIN appointments a ON a.id = r."appointmentId"
          JOIN patients p ON p.id = a."patientId"
          WHERE r.id = ${record.id} AND r."patientId" IS NULL
            AND r."appointmentId" = ${record.appointmentId}
            AND r."clinicId" = ${record.clinicId}
            AND a."clinicId" = r."clinicId" AND p."clinicId" = a."clinicId"
            AND a."patientId" = ${patientId} AND p."deletedAt" IS NULL
          FOR UPDATE OF r, a, p
        `;
        if (proof.length === 0) return 0;
        const result = await tx.clinicalRecord.updateMany({
          where: {
            id: record.id,
            clinicId: record.clinicId,
            appointmentId: record.appointmentId,
            patientId: null,
          },
          data: { patientId },
        });
        return result.count;
      });
      counts.clinicalRecords.assigned += updated;
      continue;
    }
    counts.clinicalRecords.assigned += 1;
  }
}

export async function collect(prisma: PrismaClient): Promise<Counts> {
  const [
    apptTotal,
    apptUnresolved,
    recTotal,
    recUnresolved,
    odoTotal,
    odoUnresolved,
    avaTotal,
    avaUnresolved,
  ] = await Promise.all([
    prisma.appointment.count(),
    prisma.appointment.count({ where: { patientId: null } }),
    prisma.clinicalRecord.count(),
    prisma.clinicalRecord.count({ where: { patientId: null } }),
    prisma.odontogramRecord.count(),
    prisma.odontogramRecord.count({ where: { patientId: null } }),
    prisma.patientAvatar.count(),
    prisma.patientAvatar.count({ where: { patientId: null } }),
  ]);

  return {
    appointments: {
      total: apptTotal,
      assigned: apptTotal - apptUnresolved,
      unresolved: apptUnresolved,
    },
    clinicalRecords: {
      total: recTotal,
      assigned: recTotal - recUnresolved,
      unresolved: recUnresolved,
    },
    odontograms: {
      total: odoTotal,
      assigned: odoTotal - odoUnresolved,
      unresolved: odoUnresolved,
    },
    avatars: {
      total: avaTotal,
      assigned: avaTotal - avaUnresolved,
      unresolved: avaUnresolved,
    },
    patientsCreated: 0,
  };
}

function report(label: string, counts: Counts): void {
  const row = (
    name: string,
    c: { total: number; assigned: number; unresolved: number },
  ) =>
    console.log(
      `  ${name.padEnd(18)} total ${String(c.total).padStart(6)}` +
        `   with identity ${String(c.assigned).padStart(6)}` +
        `   quarantined ${String(c.unresolved).padStart(6)}`,
    );

  console.log(`\n${label}`);
  row('appointments', counts.appointments);
  row('clinical records', counts.clinicalRecords);
  row('odontograms', counts.odontograms);
  row('avatars', counts.avatars);
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL ?? '';
  assertDisposableTarget(url);

  // Same driver adapter the application uses, so the script sees exactly the
  // database the API sees.
  const pool = new Pool({ connectionString: url });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const before = await collect(prisma);
    report('BEFORE', before);

    const applied = emptyCounts();

    await backfillRecordsFromAppointments(prisma, applied);

    console.log(
      `\nDeterministic assignment${APPLY ? '' : ' (dry run)'}:\n` +
        `  RECORD_FROM_APPT   records assigned: ${applied.clinicalRecords.assigned}\n` +
        '\nLegacy appointments are never assigned automatically: nothing in the\n' +
        'data proves which person they belong to. Assign them deliberately, then\n' +
        're-run to propagate that identity to their clinical records.',
    );

    const after = await collect(prisma);
    report(APPLY ? 'AFTER' : 'AFTER (unchanged — dry run)', after);

    const quarantined =
      after.appointments.unresolved +
      after.clinicalRecords.unresolved +
      after.odontograms.unresolved +
      after.avatars.unresolved;

    console.log(
      `\n${quarantined} row(s) remain without a stable identity.\n` +
        'These are not failures. No structural relationship proves who they\n' +
        'belong to, so they were deliberately left for operator review rather\n' +
        'than merged on matching contact details. They continue to resolve\n' +
        'through the legacy path, which refuses ambiguous lookups.\n',
    );

    if (!APPLY) {
      console.log('Dry run — nothing was written. Re-run with --apply.\n');
    }
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
