import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

interface PatientRow {
  identifier: string;
  patientName: string;
  patientEmail: string | null;
  patientPhone: string | null;
  totalAppointments: bigint;
  completedAppointments: bigint;
  canceledAppointments: bigint;
  lastVisit: Date | null;
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
          COALESCE("patientEmail", "patientName") AS identifier,
          "patientName",
          "patientEmail",
          MAX("patientPhone") AS "patientPhone",
          COUNT(*)::bigint AS "totalAppointments",
          COUNT(CASE WHEN status::text = 'COMPLETED' THEN 1 END)::bigint AS "completedAppointments",
          COUNT(CASE WHEN status::text = 'CANCELED' THEN 1 END)::bigint AS "canceledAppointments",
          MAX("appointmentDate") AS "lastVisit"
        FROM appointments
        WHERE "clinicId" = ${clinicId}
        ${searchFilter}
        GROUP BY COALESCE("patientEmail", "patientName"), "patientName", "patientEmail"
        ORDER BY MAX("appointmentDate") DESC NULLS LAST
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
    }));

    return { data, total: data.length };
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
}
