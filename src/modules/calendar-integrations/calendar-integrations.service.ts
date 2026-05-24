import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
} from '@nestjs/common';
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { googleCalendarConfig } from '../../config/google-calendar.config';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const GOOGLE_CALENDAR_API_URL = 'https://www.googleapis.com/calendar/v3';
const GOOGLE_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
];
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const SYNC_CHUNK_SIZE = 5;

type GoogleCalendarStatus = {
  connected: boolean;
  calendarSummary: string | null;
  connectedAt: Date | null;
  lastSyncedAt: Date | null;
}

type IntegrationRow = {
  id: string;
  clinicId: string;
  googleCalendarId: string;
  googleCalendarSummary: string | null;
  accessTokenEncrypted: string;
  refreshTokenEncrypted: string;
  tokenExpiresAt: Date;
  connectedAt: Date;
  lastSyncedAt: Date | null;
}

type OAuthStateRow = {
  id: string;
  clinicId: string;
  userId: string;
  expiresAt: Date;
}

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

type CalendarInfoResponse = {
  id?: string;
  summary?: string;
}

type AppointmentSyncRow = {
  id: string;
  googleCalendarEventId: string | null;
  appointmentDate: Date | string;
  startTime: Date | string;
  endTime: Date | string;
  profileName: string;
  timezone: string;
  patientName: string | null;
}

type AppointmentGoogleEventRow = {
  id: string;
  googleCalendarEventId: string | null;
}

type GoogleEventResponse = {
  id?: string;
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{ domain?: string; reason?: string; message?: string }>;
  };
}

@Injectable()
export class CalendarIntegrationsService {
  constructor(private readonly prisma: PrismaService) {}

  async getStatus(clinicId: string): Promise<GoogleCalendarStatus> {
    const integration = await this.findActiveIntegration(clinicId);

    return {
      connected: Boolean(integration),
      calendarSummary: integration?.googleCalendarSummary ?? null,
      connectedAt: integration?.connectedAt ?? null,
      lastSyncedAt: integration?.lastSyncedAt ?? null,
    };
  }

  async createConnectUrl(clinicId: string, userId: string) {
    this.assertConfig();
    await this.prisma.$executeRaw`
      DELETE FROM "google_calendar_oauth_states"
      WHERE "clinicId" = ${clinicId} OR "expiresAt" < NOW()
    `;

    const state = randomUUID();
    const expiresAt = new Date(Date.now() + OAUTH_STATE_TTL_MS);

    await this.prisma.$executeRaw`
      INSERT INTO "google_calendar_oauth_states" ("id", "clinicId", "userId", "expiresAt")
      VALUES (${state}, ${clinicId}, ${userId}, ${expiresAt})
    `;

    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set('client_id', googleCalendarConfig.clientId);
    url.searchParams.set('redirect_uri', googleCalendarConfig.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', GOOGLE_CALENDAR_SCOPES.join(' '));
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');
    url.searchParams.set('state', state);

    return { url: url.toString() };
  }

  async handleCallback(code: string | undefined, state: string | undefined) {
    this.assertConfig();

    if (!code || !state) {
      throw new BadRequestException('Retorno do Google Agenda incompleto.');
    }

    const [storedState] = await this.prisma.$queryRaw<OAuthStateRow[]>`
      SELECT "id", "clinicId", "userId", "expiresAt"
      FROM "google_calendar_oauth_states"
      WHERE "id" = ${state}
      LIMIT 1
    `;

    if (!storedState || storedState.expiresAt.getTime() < Date.now()) {
      throw new BadRequestException('Sessão de conexão do Google Agenda expirada.');
    }

    const token = await this.exchangeCodeForToken(code);
    if (!token.access_token || !token.refresh_token) {
      throw new BadRequestException(
        'O Google não retornou autorização completa. Tente conectar novamente.',
      );
    }

    const calendarInfo = await this.fetchCalendarInfo(token.access_token);
    const expiresAt = new Date(Date.now() + (token.expires_in ?? 3600) * 1000);
    const accessTokenEncrypted = this.encrypt(token.access_token);
    const refreshTokenEncrypted = this.encrypt(token.refresh_token);

    await this.prisma.$executeRaw`
      INSERT INTO "google_calendar_integrations" (
        "id",
        "clinicId",
        "connectedByUserId",
        "googleCalendarId",
        "googleCalendarSummary",
        "accessTokenEncrypted",
        "refreshTokenEncrypted",
        "tokenExpiresAt",
        "connectedAt",
        "disconnectedAt",
        "updatedAt"
      )
      VALUES (
        ${randomUUID()},
        ${storedState.clinicId},
        ${storedState.userId},
        ${calendarInfo.id ?? 'primary'},
        ${calendarInfo.summary ?? null},
        ${accessTokenEncrypted},
        ${refreshTokenEncrypted},
        ${expiresAt},
        NOW(),
        NULL,
        NOW()
      )
      ON CONFLICT ("clinicId") DO UPDATE SET
        "connectedByUserId" = EXCLUDED."connectedByUserId",
        "googleCalendarId" = EXCLUDED."googleCalendarId",
        "googleCalendarSummary" = EXCLUDED."googleCalendarSummary",
        "accessTokenEncrypted" = EXCLUDED."accessTokenEncrypted",
        "refreshTokenEncrypted" = EXCLUDED."refreshTokenEncrypted",
        "tokenExpiresAt" = EXCLUDED."tokenExpiresAt",
        "connectedAt" = NOW(),
        "disconnectedAt" = NULL,
        "updatedAt" = NOW()
    `;

    await this.prisma.$executeRaw`
      DELETE FROM "google_calendar_oauth_states" WHERE "id" = ${state}
    `;

    // Initial sync is best-effort — a failure here must not undo a successful connection.
    try {
      await this.sync(storedState.clinicId);
    } catch {
      console.warn('[CalendarIntegrations] Initial sync after connect failed — connection is still active.');
    }
  }

  async disconnect(clinicId: string) {
    this.assertConfig();

    const integration = await this.findActiveIntegration(clinicId);
    if (!integration) {
      return {
        connected: false,
        calendarSummary: null,
        connectedAt: null,
        lastSyncedAt: null,
      };
    }

    // Best-effort: clean up Google Calendar events and revoke the token.
    // If the token is already expired, revoked externally, or Google returns any error,
    // we log a warning and still complete the local disconnect so the user is never stuck.
    try {
      const accessToken = await this.getValidAccessToken(integration);
      await this.deleteSyncedGoogleEvents(clinicId, integration.googleCalendarId, accessToken);
      await this.revokeGoogleToken(this.decrypt(integration.refreshTokenEncrypted));
    } catch {
      console.warn('[CalendarIntegrations] Google cleanup during disconnect failed — proceeding with local disconnect.');
    }

    await this.prisma.$executeRaw`
      UPDATE "google_calendar_integrations"
      SET "disconnectedAt" = NOW(), "updatedAt" = NOW()
      WHERE "clinicId" = ${clinicId}
    `;

    return {
      connected: false,
      calendarSummary: null,
      connectedAt: null,
      lastSyncedAt: null,
    };
  }

  async deleteAppointmentEvent(clinicId: string, appointmentId: string) {
    const integration = await this.findActiveIntegration(clinicId);
    if (!integration) return;

    const [appointment] = await this.prisma.$queryRaw<AppointmentGoogleEventRow[]>`
      SELECT "id", "googleCalendarEventId"
      FROM "appointments"
      WHERE "id" = ${appointmentId} AND "clinicId" = ${clinicId}
      LIMIT 1
    `;

    if (!appointment?.googleCalendarEventId) return;

    const accessToken = await this.getValidAccessToken(integration);
    await this.deleteGoogleEvent(
      accessToken,
      integration.googleCalendarId,
      appointment.googleCalendarEventId,
    );

    await this.prisma.$executeRaw`
      UPDATE "appointments"
      SET "googleCalendarEventId" = NULL
      WHERE "id" = ${appointmentId} AND "clinicId" = ${clinicId}
    `;
  }

  async sync(clinicId: string) {
    this.assertConfig();

    const integration = await this.findActiveIntegration(clinicId);
    if (!integration) {
      throw new BadRequestException('Google Agenda não está conectado.');
    }

    const accessToken = await this.getValidAccessToken(integration);
    const appointments = await this.findAppointmentsToSync(clinicId);

    const chunks = chunkArray(appointments, SYNC_CHUNK_SIZE);
    let synced = 0;
    let failed = 0;

    for (const chunk of chunks) {
      const settled = await Promise.allSettled(
        chunk.map((appointment) =>
          this.upsertGoogleEvent(accessToken, integration.googleCalendarId, appointment)
            .then((eventId) => ({ appointment, eventId })),
        ),
      );

      for (let i = 0; i < settled.length; i++) {
        const result = settled[i];
        const appointment = chunk[i];

        if (result.status === 'rejected') {
          failed += 1;
          continue;
        }

        const { eventId } = result.value;
        if (eventId && eventId !== appointment.googleCalendarEventId) {
          await this.prisma.$executeRaw`
            UPDATE "appointments"
            SET "googleCalendarEventId" = ${eventId}
            WHERE "id" = ${appointment.id}
          `;
        }
        synced += 1;
      }
    }

    if (failed > 0) {
      console.warn(
        `[CalendarIntegrations] Sync completed with failures — synced: ${synced}, failed: ${failed}`,
      );
    }

    await this.prisma.$executeRaw`
      UPDATE "google_calendar_integrations"
      SET "lastSyncedAt" = NOW(), "updatedAt" = NOW()
      WHERE "clinicId" = ${clinicId}
    `;

    return { synced, failed };
  }

  private async findActiveIntegration(clinicId: string) {
    const [integration] = await this.prisma.$queryRaw<IntegrationRow[]>`
      SELECT
        "id",
        "clinicId",
        "googleCalendarId",
        "googleCalendarSummary",
        "accessTokenEncrypted",
        "refreshTokenEncrypted",
        "tokenExpiresAt",
        "connectedAt",
        "lastSyncedAt"
      FROM "google_calendar_integrations"
      WHERE "clinicId" = ${clinicId} AND "disconnectedAt" IS NULL
      LIMIT 1
    `;

    return integration ?? null;
  }

  private async exchangeCodeForToken(code: string) {
    const body = new URLSearchParams({
      code,
      client_id: googleCalendarConfig.clientId,
      client_secret: googleCalendarConfig.clientSecret,
      redirect_uri: googleCalendarConfig.redirectUri,
      grant_type: 'authorization_code',
    });

    return this.postTokenRequest(body);
  }

  private async refreshAccessToken(integration: IntegrationRow) {
    const body = new URLSearchParams({
      client_id: googleCalendarConfig.clientId,
      client_secret: googleCalendarConfig.clientSecret,
      refresh_token: this.decrypt(integration.refreshTokenEncrypted),
      grant_type: 'refresh_token',
    });

    return this.postTokenRequest(body);
  }

  private async revokeGoogleToken(token: string) {
    const body = new URLSearchParams({ token });
    const response = await fetch(GOOGLE_REVOKE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });

    if (!response.ok) {
      throw new BadRequestException('Não foi possível revogar o acesso ao Google Agenda.');
    }
  }

  private async postTokenRequest(body: URLSearchParams): Promise<TokenResponse> {
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const token = (await response.json()) as TokenResponse;

    if (!response.ok) {
      throw new BadRequestException('Não foi possível autenticar no Google Agenda.');
    }

    return token;
  }

  private async fetchCalendarInfo(accessToken: string): Promise<CalendarInfoResponse> {
    const response = await fetch(`${GOOGLE_CALENDAR_API_URL}/users/me/calendarList/primary`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      throw new BadRequestException('Não foi possível acessar o calendário principal.');
    }

    return response.json() as Promise<CalendarInfoResponse>;
  }

  private async getValidAccessToken(integration: IntegrationRow) {
    if (integration.tokenExpiresAt.getTime() > Date.now() + 60_000) {
      return this.decrypt(integration.accessTokenEncrypted);
    }

    const token = await this.refreshAccessToken(integration);
    if (!token.access_token) {
      throw new BadRequestException('Não foi possível renovar o acesso ao Google Agenda.');
    }

    const expiresAt = new Date(Date.now() + (token.expires_in ?? 3600) * 1000);
    await this.prisma.$executeRaw`
      UPDATE "google_calendar_integrations"
      SET
        "accessTokenEncrypted" = ${this.encrypt(token.access_token)},
        "tokenExpiresAt" = ${expiresAt},
        "updatedAt" = NOW()
      WHERE "id" = ${integration.id}
    `;

    return token.access_token;
  }

  private async findAppointmentsToSync(clinicId: string) {
    return this.prisma.$queryRaw<AppointmentSyncRow[]>`
      SELECT
        a."id",
        a."googleCalendarEventId",
        a."appointmentDate",
        a."startTime",
        a."endTime",
        p."displayName" AS "profileName",
        c."timezone" AS "timezone",
        a."patientName"
      FROM "appointments" a
      INNER JOIN "profiles" p ON p."id" = a."profileId"
      INNER JOIN "clinics" c ON c."id" = a."clinicId"
      WHERE
        a."clinicId" = ${clinicId}
        AND a."status" NOT IN ('CANCELED')
        AND a."appointmentDate" >= CURRENT_DATE
      ORDER BY a."appointmentDate" ASC, a."startTime" ASC
    `;
  }

  private async findAppointmentsWithGoogleEvents(clinicId: string) {
    return this.prisma.$queryRaw<AppointmentGoogleEventRow[]>`
      SELECT "id", "googleCalendarEventId"
      FROM "appointments"
      WHERE "clinicId" = ${clinicId} AND "googleCalendarEventId" IS NOT NULL
    `;
  }

  private async deleteSyncedGoogleEvents(
    clinicId: string,
    calendarId: string,
    accessToken: string,
  ) {
    const appointments = await this.findAppointmentsWithGoogleEvents(clinicId);

    await Promise.allSettled(
      appointments
        .filter((a) => a.googleCalendarEventId)
        .map((a) =>
          this.deleteGoogleEvent(accessToken, calendarId, a.googleCalendarEventId as string),
        ),
    );

    await this.prisma.$executeRaw`
      UPDATE "appointments"
      SET "googleCalendarEventId" = NULL
      WHERE "clinicId" = ${clinicId} AND "googleCalendarEventId" IS NOT NULL
    `;
  }

  private async upsertGoogleEvent(
    accessToken: string,
    calendarId: string,
    appointment: AppointmentSyncRow,
  ) {
    if (appointment.googleCalendarEventId) {
      const updated = await this.sendGoogleEventRequest(
        accessToken,
        calendarId,
        appointment,
        appointment.googleCalendarEventId,
      );
      if (updated.id) return updated.id;
      if (updated.error?.code !== 404) {
        throw new BadRequestException('Não foi possível atualizar evento no Google Agenda.');
      }
    }

    const created = await this.sendGoogleEventRequest(accessToken, calendarId, appointment);
    if (!created.id) {
      throw new BadRequestException('Não foi possível criar evento no Google Agenda.');
    }
    return created.id;
  }

  private async sendGoogleEventRequest(
    accessToken: string,
    calendarId: string,
    appointment: AppointmentSyncRow,
    eventId?: string,
  ): Promise<GoogleEventResponse> {
    const timeZone = appointment.timezone || 'America/Sao_Paulo';
    const date = formatDateInputValue(appointment.appointmentDate);
    const startTime = formatTimeInputValue(appointment.startTime);
    const endTime = formatTimeInputValue(appointment.endTime);
    const body = {
      summary: appointment.patientName
        ? `Consulta - ${appointment.patientName}`
        : 'Consulta odontologica',
      description: [
        'Evento sincronizado pelo DentalFlow.',
        `Profissional: ${appointment.profileName}`,
        'Dados do paciente ficam disponiveis apenas no DentalFlow.',
      ].join('\n'),
      start: { dateTime: `${date}T${startTime}:00`, timeZone },
      end: { dateTime: `${date}T${endTime}:00`, timeZone },
    };
    const encodedCalendarId = encodeURIComponent(calendarId);
    const url = eventId
      ? `${GOOGLE_CALENDAR_API_URL}/calendars/${encodedCalendarId}/events/${encodeURIComponent(eventId)}`
      : `${GOOGLE_CALENDAR_API_URL}/calendars/${encodedCalendarId}/events`;
    const response = await fetch(url, {
      method: eventId ? 'PATCH' : 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as GoogleEventResponse;

    if (!response.ok && payload.error?.code !== 404) {
      const op = eventId ? 'update' : 'create';
      const reason = payload.error?.errors?.[0]?.reason ?? 'none';
      console.warn(
        `[CalendarIntegrations] Google API error — op: ${op}, appointmentId: ${appointment.id}, ` +
        `httpStatus: ${response.status}, errorCode: ${payload.error?.code ?? 'none'}, ` +
        `errorStatus: ${payload.error?.status ?? 'none'}, reason: ${reason}, ` +
        `message: ${payload.error?.message ?? 'none'}`,
      );
      throw new BadRequestException('Erro ao sincronizar evento no Google Agenda.');
    }

    return payload;
  }

  private async deleteGoogleEvent(accessToken: string, calendarId: string, eventId: string) {
    const encodedCalendarId = encodeURIComponent(calendarId);
    const response = await fetch(
      `${GOOGLE_CALENDAR_API_URL}/calendars/${encodedCalendarId}/events/${encodeURIComponent(eventId)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      },
    );

    if (response.ok || response.status === 404 || response.status === 410) {
      return;
    }

    throw new BadRequestException('Não foi possível remover evento no Google Agenda.');
  }

  private assertConfig() {
    if (
      !googleCalendarConfig.clientId ||
      !googleCalendarConfig.clientSecret ||
      !googleCalendarConfig.redirectUri ||
      !googleCalendarConfig.tokenSecret
    ) {
      throw new InternalServerErrorException(
        'Configuração do Google Agenda incompleta no backend.',
      );
    }
  }

  private encrypt(value: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.getEncryptionKey(), iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [iv, tag, encrypted].map((item) => item.toString('base64')).join(':');
  }

  private decrypt(value: string): string {
    const [iv, tag, encrypted] = value.split(':').map((part) => Buffer.from(part, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', this.getEncryptionKey(), iv);
    decipher.setAuthTag(tag);

    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }

  private getEncryptionKey(): Buffer {
    return createHash('sha256').update(googleCalendarConfig.tokenSecret).digest();
  }
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function formatDateInputValue(date: Date | string): string {
  if (typeof date === 'string') {
    const match = date.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) return match[1];
    return formatDateInputValue(new Date(date));
  }

  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  ].join('-');
}

function formatTimeInputValue(time: Date | string): string {
  if (typeof time === 'string') {
    const match = time.match(/^(\d{2}):(\d{2})/);
    if (match) return `${match[1]}:${match[2]}`;
    return formatTimeInputValue(new Date(time));
  }

  return [
    String(time.getUTCHours()).padStart(2, '0'),
    String(time.getUTCMinutes()).padStart(2, '0'),
  ].join(':');
}
