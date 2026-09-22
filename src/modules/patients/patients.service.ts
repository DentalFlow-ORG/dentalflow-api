import { Injectable } from '@nestjs/common';
import {
  AppointmentPaymentStatus,
  AppointmentStatus,
  NotificationChannel,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PatientResolverService } from '../../common/services/patient-resolver.service';
import { brazilTodayIso } from '../../common/utils/brazil-timezone';
import {
  normalizePatientEmail,
  patientIdentifierFor,
  patientIdentityKey,
} from '../../common/utils/patient-identity';

interface PatientRow {
  patientId: string | null;
  identifier: string;
  patientName: string;
  patientEmail: string | null;
  patientPhone: string | null;
  totalAppointments: bigint;
  completedAppointments: bigint;
  canceledAppointments: bigint;
  lastVisit: Date | null;
  avatarUrl: string | null;
}

export type AttentionReason =
  | 'INACTIVE'
  | 'NO_UPCOMING_APPOINTMENT'
  | 'PENDING_PAYMENT'
  | 'RECENTLY_CANCELED'
  | 'RECENT_NO_SHOW';

export type AttentionPriority = 'HIGH' | 'MEDIUM' | 'LOW';

export interface AttentionItem {
  patientId: string | null;
  identifier: string;
  patientName: string;
  patientEmail: string | null;
  patientPhone: string | null;
  lastAppointmentAt: string | null;
  nextAppointmentAt: string | null;
  lastProfessionalName: string | null;
  reason: AttentionReason;
  allReasons: AttentionReason[];
  priority: AttentionPriority;
  pendingAmountCents: number;
  hasWhatsappConsent: boolean;
}

@Injectable()
export class PatientsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly patientResolver: PatientResolverService,
  ) {}

  async listPatients(clinicId: string, search?: string) {
    const searchFilter = search?.trim()
      ? Prisma.sql`AND (n.norm_name ILIKE ${`%${search.trim()}%`} OR n.norm_email ILIKE ${`%${search.trim()}%`} OR p.name ILIKE ${`%${search.trim()}%`} OR p.email ILIKE ${`%${search.trim()}%`})`
      : Prisma.sql``;

    // Appointments group on `patientId` once they have one, so a patient who
    // changed email or was typed differently stays a single row, and two people
    // who share every contact value stay separate rows.
    //
    // Rows that predate the identity migration have no patientId, so they fall
    // back to the normalized contact key — the legacy behaviour, kept only so
    // historical appointments remain visible until an operator assigns them an
    // identity. Contact values never group a row that already has a patientId.
    const rows = await this.prisma.$queryRaw<PatientRow[]>(
      Prisma.sql`
        WITH n AS (
          SELECT
            a."clinicId",
            a.status,
            a."appointmentDate",
            a."patientPhone",
            a."patientId",
            NULLIF(LOWER(TRIM(a."patientEmail")), '') AS norm_email,
            TRIM(a."patientName") AS norm_name,
            COALESCE(
              a."patientId",
              NULLIF(LOWER(TRIM(a."patientEmail")), ''),
              LOWER(TRIM(a."patientName"))
            ) AS identity_key
          FROM appointments a
          WHERE a."clinicId" = ${clinicId}
        )
        SELECT
          n."patientId" AS "patientId",
          COALESCE(MAX(p.email), MAX(n.norm_email), MAX(n.norm_name)) AS identifier,
          COALESCE(MAX(p.name), MAX(n.norm_name)) AS "patientName",
          COALESCE(MAX(p.email), MAX(n.norm_email)) AS "patientEmail",
          COALESCE(MAX(p.phone), MAX(n."patientPhone")) AS "patientPhone",
          COUNT(*)::bigint AS "totalAppointments",
          COUNT(CASE WHEN n.status::text = 'COMPLETED' THEN 1 END)::bigint AS "completedAppointments",
          COUNT(CASE WHEN n.status::text = 'CANCELED' THEN 1 END)::bigint AS "canceledAppointments",
          MAX(n."appointmentDate") AS "lastVisit",
          MAX(COALESCE(pid."avatarUrl", pa."avatarUrl")) AS "avatarUrl"
        FROM n
        LEFT JOIN patients p
          ON p.id = n."patientId"
          AND p."clinicId" = n."clinicId"
          AND p."deletedAt" IS NULL
        LEFT JOIN patient_avatars pid
          ON pid."clinicId" = n."clinicId"
          AND pid."patientId" = n."patientId"
        LEFT JOIN (
          SELECT "clinicId", LOWER(TRIM(identifier)) AS identifier, MAX("avatarUrl") AS "avatarUrl"
          FROM patient_avatars
          WHERE "clinicId" = ${clinicId} AND "patientId" IS NULL
          GROUP BY "clinicId", LOWER(TRIM(identifier))
        ) pa
          ON pa."clinicId" = n."clinicId"
          AND n."patientId" IS NULL
          AND pa.identifier = n.identity_key
        WHERE TRUE
        ${searchFilter}
        GROUP BY n.identity_key, n."patientId"
        ORDER BY MAX(n."appointmentDate") DESC NULLS LAST
      `,
    );

    const data = rows.map((row) => ({
      patientId: row.patientId ?? null,
      identifier: row.identifier,
      patientName: row.patientName,
      patientEmail: row.patientEmail,
      patientPhone: row.patientPhone,
      totalAppointments: Number(row.totalAppointments),
      completedAppointments: Number(row.completedAppointments),
      canceledAppointments: Number(row.canceledAppointments),
      lastVisit: row.lastVisit
        ? row.lastVisit.toISOString().slice(0, 10)
        : null,
      avatarUrl: row.avatarUrl ?? null,
    }));

    return { data, total: data.length };
  }

  async getPatientAvatar(
    clinicId: string,
    identifier: string,
    patientId?: string,
  ) {
    const resolved = await this.patientResolver.resolveReference(
      clinicId,
      identifier,
      patientId,
    );
    patientId = resolved?.id;
    // A patientId keeps two people who share an address on separate avatars.
    // Without one, the legacy identifier is matched case-insensitively so
    // avatars stored before normalization still resolve.
    const row = await this.prisma.patientAvatar.findFirst({
      where: {
        clinicId,
        ...(patientId
          ? { patientId }
          : {
              patientId: null,
              identifier: { equals: identifier.trim(), mode: 'insensitive' },
            }),
      },
      select: { avatarUrl: true },
    });
    return { avatarUrl: row?.avatarUrl ?? null };
  }

  async batchGetPatientAvatars(
    clinicId: string,
    rawIdentifiers: string[],
  ): Promise<{ avatars: Record<string, string | null> }> {
    // Trim, filter blanks, and deduplicate before hitting the database.
    const identifiers = [
      ...new Set(
        rawIdentifiers.map((id) => id.trim()).filter((id) => id.length > 0),
      ),
    ];

    if (identifiers.length === 0) return { avatars: {} };

    // Compatibility resolution must also guard the legacy batch entry point.
    const references = await Promise.all(
      identifiers.map((identifier) =>
        this.patientResolver.resolveReference(clinicId, identifier),
      ),
    );
    if (references.some(Boolean)) {
      const entries = await Promise.all(
        identifiers.map(async (identifier, index) => {
          const avatar = await this.getPatientAvatar(
            clinicId,
            identifier,
            references[index]?.id,
          );
          return [identifier, avatar.avatarUrl] as const;
        }),
      );
      return { avatars: Object.fromEntries(entries) };
    }

    // Case-insensitive lookup keeps avatars stored under a pre-normalization
    // spelling reachable from the normalized identifiers clients now send.
    const keys = identifiers.map((id) => id.toLowerCase());
    const rows = await this.prisma.$queryRaw<
      { identifier: string; avatarUrl: string | null }[]
    >(
      Prisma.sql`
        SELECT identifier, "avatarUrl"
        FROM patient_avatars
        WHERE "clinicId" = ${clinicId}
          AND "patientId" IS NULL
          AND LOWER(TRIM(identifier)) IN (${Prisma.join(keys)})
      `,
    );

    const byKey = new Map<string, string | null>();
    for (const row of rows) {
      byKey.set(row.identifier.trim().toLowerCase(), row.avatarUrl ?? null);
    }

    // Build result: every requested identifier gets an entry (null if absent).
    const avatars: Record<string, string | null> = {};
    for (const id of identifiers) {
      avatars[id] = byKey.get(id.toLowerCase()) ?? null;
    }

    return { avatars };
  }

  async upsertPatientAvatar(
    clinicId: string,
    identifier: string,
    avatarBase64: string | null | undefined,
    patientId?: string,
  ) {
    // The patient must be addressable by this clinic before anything is
    // written against it. Without this check a clinic could create an avatar
    // row pointing at another tenant's patient id.
    const resolved = await this.patientResolver.resolveReference(
      clinicId,
      identifier,
      patientId,
    );
    patientId = resolved?.id;

    // With a patientId the row belongs to that patient alone, enforced by the
    // (clinicId, patientId) unique index. Without one, reuse a row that differs
    // only by casing or padding so a patient does not accumulate one avatar per
    // spelling of their email.
    const existing = await this.prisma.patientAvatar.findFirst({
      where: {
        clinicId,
        ...(patientId
          ? { patientId }
          : {
              patientId: null,
              identifier: { equals: identifier.trim(), mode: 'insensitive' },
            }),
      },
      select: { id: true },
    });

    if (existing) {
      await this.prisma.patientAvatar.update({
        where: { id: existing.id },
        data: { avatarUrl: avatarBase64 ?? null },
      });
      return;
    }

    await this.prisma.patientAvatar.create({
      data: {
        clinicId,
        patientId: patientId ?? null,
        // `identifier` predates stable identity and still carries a
        // (clinicId, identifier) unique index, which two patients sharing an
        // address would collide on. Once a row has a patientId that column is
        // the identity, so the legacy key is set to it to keep the old index
        // satisfied without letting contact values group two people.
        identifier: patientId ?? identifier.trim(),
        avatarUrl: avatarBase64 ?? null,
      },
    });
  }

  async getPatientHistory(
    clinicId: string,
    identifier: string,
    patientId?: string,
  ) {
    // A supplied patientId is identity: no contact value takes part in the
    // lookup, so two people sharing every attribute keep separate histories.
    // Without one, legacy contact matching still serves un-migrated rows.
    const patientWhere = await this.patientResolver.scopeWhere(
      clinicId,
      identifier,
      patientId,
    );
    const appointments = await this.prisma.appointment.findMany({
      where: {
        clinicId,
        ...patientWhere,
      },
      include: {
        service: { select: { id: true, name: true } },
        profile: { select: { id: true, displayName: true } },
      },
      orderBy: [{ appointmentDate: 'desc' }, { startTime: 'desc' }],
    });

    return { appointments };
  }

  async getPatientsAttention(clinicId: string) {
    // appointmentDate is stored as UTC midnight. Use UTC midnight of the Brazil
    // calendar date so day boundaries don't shift during 00:00-03:00 UTC.
    const todayStr = brazilTodayIso();
    const [ty, tm, td] = todayStr.split('-').map(Number);
    const today = new Date(Date.UTC(ty, tm - 1, td));
    const thirtyDaysAgo = new Date(Date.UTC(ty, tm - 1, td - 30));
    const ninetyDaysAgo = new Date(Date.UTC(ty, tm - 1, td - 90));

    // Load all appointments with profile info (ordered ascending for processing)
    const appointments = await this.prisma.appointment.findMany({
      where: { clinicId },
      select: {
        patientId: true,
        patientName: true,
        patientEmail: true,
        patientPhone: true,
        appointmentDate: true,
        status: true,
        paymentStatus: true,
        estimatedAmountCents: true,
        paidAmountCents: true,
        profile: { select: { displayName: true } },
      },
      orderBy: { appointmentDate: 'asc' },
    });

    type Appt = (typeof appointments)[number];

    // Group appointments by patient identifier (email preferred over name)
    const groupMap = new Map<
      string,
      {
        patientId: string | null;
        identifier: string;
        patientName: string;
        patientEmail: string | null;
        patientPhone: string | null;
        appointments: Appt[];
      }
    >();

    for (const appt of appointments) {
      // Same key and same emitted identifier as the patient list and the
      // history lookup, so the attention queue cannot disagree with them
      // about who a patient is.
      const key = appt.patientId
        ? `patient:${appt.patientId}`
        : `legacy:${patientIdentityKey(appt)}`;

      if (!groupMap.has(key)) {
        groupMap.set(key, {
          patientId: appt.patientId ?? null,
          identifier: patientIdentifierFor(appt),
          patientName: appt.patientName.trim(),
          patientEmail: normalizePatientEmail(appt.patientEmail),
          patientPhone: null,
          appointments: [],
        });
      }
      const group = groupMap.get(key)!;
      if (appt.patientPhone && !group.patientPhone) {
        group.patientPhone = appt.patientPhone;
      }
      group.appointments.push(appt);
    }

    const items: AttentionItem[] = [];

    for (const [, group] of groupMap) {
      const { appointments: appts } = group;

      // Only consider non-canceled appointments for "active" history
      const nonCanceled = appts.filter(
        (a) => a.status !== AppointmentStatus.CANCELED,
      );
      if (nonCanceled.length === 0) continue;

      const past = nonCanceled.filter((a) => a.appointmentDate <= today);
      const future = nonCanceled.filter((a) => a.appointmentDate > today);

      const hasUpcoming = future.length > 0;
      // Arrays are sorted ASC — last past = last element, first future = first element
      const lastPast = past.length > 0 ? past[past.length - 1] : null;
      const firstFuture = future.length > 0 ? future[0] : null;

      // Pending payments: completed appointments with unpaid/partially-paid status
      const pendingPaymentAppts = appts.filter(
        (a) =>
          a.status === AppointmentStatus.COMPLETED &&
          (a.paymentStatus === AppointmentPaymentStatus.PAYMENT_PENDING ||
            a.paymentStatus === AppointmentPaymentStatus.PARTIALLY_PAID),
      );
      const pendingAmountCents = pendingPaymentAppts.reduce((sum, a) => {
        return (
          sum +
          Math.max(0, (a.estimatedAmountCents ?? 0) - (a.paidAmountCents ?? 0))
        );
      }, 0);

      // Recent events (last 30 days)
      const recentlyCanceled = appts.some(
        (a) =>
          a.status === AppointmentStatus.CANCELED &&
          a.appointmentDate >= thirtyDaysAgo,
      );
      const recentNoShow = appts.some(
        (a) =>
          a.status === AppointmentStatus.NO_SHOW &&
          a.appointmentDate >= thirtyDaysAgo,
      );

      // Determine reasons in descending priority order
      const allReasons: AttentionReason[] = [];

      if (pendingPaymentAppts.length > 0) allReasons.push('PENDING_PAYMENT');

      if (!hasUpcoming && lastPast) {
        if (lastPast.appointmentDate < ninetyDaysAgo) {
          allReasons.push('INACTIVE');
        } else {
          allReasons.push('NO_UPCOMING_APPOINTMENT');
        }
      }

      if (recentlyCanceled && !hasUpcoming)
        allReasons.push('RECENTLY_CANCELED');
      if (recentNoShow && !hasUpcoming) allReasons.push('RECENT_NO_SHOW');

      if (allReasons.length === 0) continue;

      const priority: AttentionPriority =
        allReasons.includes('PENDING_PAYMENT') ||
        allReasons.includes('INACTIVE')
          ? 'HIGH'
          : allReasons.includes('RECENTLY_CANCELED') ||
              allReasons.includes('RECENT_NO_SHOW')
            ? 'MEDIUM'
            : 'LOW';

      items.push({
        patientId: group.patientId,
        identifier: group.identifier,
        patientName: group.patientName,
        patientEmail: group.patientEmail,
        patientPhone: group.patientPhone,
        lastAppointmentAt:
          lastPast?.appointmentDate.toISOString().slice(0, 10) ?? null,
        nextAppointmentAt:
          firstFuture?.appointmentDate.toISOString().slice(0, 10) ?? null,
        lastProfessionalName: lastPast?.profile.displayName ?? null,
        reason: allReasons[0],
        allReasons,
        priority,
        pendingAmountCents,
        hasWhatsappConsent: false, // resolved after consent query below
      });
    }

    // Resolve WhatsApp consent by patient phone (digits only)
    const phones = [
      ...new Set(
        items
          .map((p) => p.patientPhone)
          .filter(Boolean)
          .map((p) => p!.replace(/\D/g, '')),
      ),
    ];

    if (phones.length > 0) {
      const consents = await this.prisma.notificationConsent.findMany({
        where: {
          clinicId,
          phone: { in: phones },
          channel: NotificationChannel.WHATSAPP,
          granted: true,
        },
        select: { phone: true },
      });
      const consentSet = new Set(consents.map((c) => c.phone));
      for (const item of items) {
        if (item.patientPhone) {
          item.hasWhatsappConsent = consentSet.has(
            item.patientPhone.replace(/\D/g, ''),
          );
        }
      }
    }

    // Default sort: priority (HIGH first), then last appointment DESC
    items.sort((a, b) => {
      const order: Record<AttentionPriority, number> = {
        HIGH: 0,
        MEDIUM: 1,
        LOW: 2,
      };
      const pd = order[a.priority] - order[b.priority];
      if (pd !== 0) return pd;
      // Secondary: most recent last appointment first
      const da = a.lastAppointmentAt ?? '';
      const db = b.lastAppointmentAt ?? '';
      return db.localeCompare(da);
    });

    const summary = {
      total: items.length,
      inactive: items.filter((p) => p.allReasons.includes('INACTIVE')).length,
      withoutUpcomingAppointment: items.filter(
        (p) =>
          p.allReasons.includes('INACTIVE') ||
          p.allReasons.includes('NO_UPCOMING_APPOINTMENT'),
      ).length,
      pendingPayment: items.filter((p) =>
        p.allReasons.includes('PENDING_PAYMENT'),
      ).length,
      recentlyCanceled: items.filter((p) =>
        p.allReasons.includes('RECENTLY_CANCELED'),
      ).length,
      recentNoShow: items.filter((p) => p.allReasons.includes('RECENT_NO_SHOW'))
        .length,
      withWhatsappConsent: items.filter((p) => p.hasWhatsappConsent).length,
    };

    return { summary, items };
  }
}
