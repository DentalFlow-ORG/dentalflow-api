import { Injectable } from '@nestjs/common';
import {
  AppointmentPaymentStatus,
  AppointmentStatus,
  NotificationChannel,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { brazilTodayIso } from '../../common/utils/brazil-timezone';

interface PatientRow {
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
  constructor(private readonly prisma: PrismaService) {}

  async listPatients(clinicId: string, search?: string) {
    const searchFilter = search?.trim()
      ? Prisma.sql`AND ("patientName" ILIKE ${`%${search.trim()}%`} OR "patientEmail" ILIKE ${`%${search.trim()}%`})`
      : Prisma.sql``;

    const rows = await this.prisma.$queryRaw<PatientRow[]>(
      Prisma.sql`
        SELECT
          COALESCE(a."patientEmail", a."patientName") AS identifier,
          a."patientName",
          a."patientEmail",
          MAX(a."patientPhone") AS "patientPhone",
          COUNT(*)::bigint AS "totalAppointments",
          COUNT(CASE WHEN a.status::text = 'COMPLETED' THEN 1 END)::bigint AS "completedAppointments",
          COUNT(CASE WHEN a.status::text = 'CANCELED' THEN 1 END)::bigint AS "canceledAppointments",
          MAX(a."appointmentDate") AS "lastVisit",
          MAX(pa."avatarUrl") AS "avatarUrl"
        FROM appointments a
        LEFT JOIN patient_avatars pa
          ON pa."clinicId" = a."clinicId"
          AND pa.identifier = COALESCE(a."patientEmail", a."patientName")
        WHERE a."clinicId" = ${clinicId}
        ${searchFilter}
        GROUP BY COALESCE(a."patientEmail", a."patientName"), a."patientName", a."patientEmail"
        ORDER BY MAX(a."appointmentDate") DESC NULLS LAST
      `,
    );

    const data = rows.map((row) => ({
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

  async getPatientAvatar(clinicId: string, identifier: string) {
    const row = await this.prisma.patientAvatar.findUnique({
      where: { clinicId_identifier: { clinicId, identifier } },
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

    const rows = await this.prisma.patientAvatar.findMany({
      where: { clinicId, identifier: { in: identifiers } },
      select: { identifier: true, avatarUrl: true },
    });

    // Build result: every requested identifier gets an entry (null if absent).
    const avatars: Record<string, string | null> = {};
    for (const id of identifiers) avatars[id] = null;
    for (const row of rows) avatars[row.identifier] = row.avatarUrl ?? null;

    return { avatars };
  }

  async upsertPatientAvatar(
    clinicId: string,
    identifier: string,
    avatarBase64: string | null | undefined,
  ) {
    await this.prisma.patientAvatar.upsert({
      where: { clinicId_identifier: { clinicId, identifier } },
      create: { clinicId, identifier, avatarUrl: avatarBase64 ?? null },
      update: { avatarUrl: avatarBase64 ?? null },
    });
  }

  async getPatientHistory(clinicId: string, identifier: string) {
    const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);

    const appointments = await this.prisma.appointment.findMany({
      where: {
        clinicId,
        ...(isEmail
          ? { patientEmail: identifier }
          : { patientName: identifier, patientEmail: null }),
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
        identifier: string;
        patientName: string;
        patientEmail: string | null;
        patientPhone: string | null;
        appointments: Appt[];
      }
    >();

    for (const appt of appointments) {
      const key =
        appt.patientEmail?.toLowerCase().trim() ??
        appt.patientName.trim().toLowerCase();

      if (!groupMap.has(key)) {
        groupMap.set(key, {
          identifier: appt.patientEmail ?? appt.patientName,
          patientName: appt.patientName,
          patientEmail: appt.patientEmail,
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
