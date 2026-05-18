import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import type {
  INotificationProvider,
  SendPayload,
  SendResult,
} from './notification-provider.interface';

type MetaApiResponse = {
  messages?: Array<{ id: string }>;
  error?: { message: string; code: number };
};

@Injectable()
export class WhatsAppCloudProvider implements INotificationProvider {
  private readonly logger = new Logger(WhatsAppCloudProvider.name);

  constructor(private readonly prisma: PrismaService) {}

  async send(payload: SendPayload): Promise<SendResult> {
    const apiVersion = process.env.WHATSAPP_CLOUD_API_VERSION ?? 'v19.0';
    const phoneNumberId = process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID ?? '';
    const accessToken = process.env.WHATSAPP_CLOUD_ACCESS_TOKEN ?? '';
    const language = process.env.WHATSAPP_DEFAULT_LANGUAGE ?? 'pt_BR';

    if (!phoneNumberId || !accessToken) {
      throw new Error(
        'WhatsApp Cloud API nao configurada. Verifique WHATSAPP_CLOUD_PHONE_NUMBER_ID e WHATSAPP_CLOUD_ACCESS_TOKEN.',
      );
    }

    const digits = payload.phone.replace(/\D/g, '');
    const to = digits.startsWith('55') ? `+${digits}` : `+55${digits}`;
    const components = await this.buildTemplateComponents(payload);

    const response = await fetch(
      `https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'template',
          template: {
            name: payload.templateSlug,
            language: { code: language },
            components,
          },
        }),
      },
    );

    const responseBody = (await response
      .json()
      .catch(() => ({}))) as MetaApiResponse;

    if (!response.ok) {
      this.logger.error(
        `WhatsApp Cloud API error: status=${response.status} template=${payload.templateSlug} code=${responseBody.error?.code ?? 'unknown'}`,
      );
      throw new Error(
        `WhatsApp API retornou status ${response.status}. Verifique se o template "${payload.templateSlug}" esta aprovado no Meta.`,
      );
    }

    const providerRef = responseBody.messages?.[0]?.id ?? null;
    this.logger.log(
      `WhatsApp sent: template=${payload.templateSlug} ref=${providerRef ?? 'none'}`,
    );

    return { providerRef };
  }

  private async buildTemplateComponents(payload: SendPayload): Promise<unknown[]> {
    if (!payload.appointmentId) return [];

    const appointment = await this.prisma.appointment.findUnique({
      where: { id: payload.appointmentId },
      select: {
        patientName: true,
        appointmentDate: true,
        startTime: true,
        clinic: { select: { name: true } },
      },
    });

    if (!appointment) return [];

    const date = new Date(appointment.appointmentDate).toLocaleDateString(
      'pt-BR',
      {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        timeZone: 'UTC',
      },
    );
    const time = new Date(appointment.startTime).toISOString().slice(11, 16);

    return [
      {
        type: 'body',
        parameters: [
          { type: 'text', text: appointment.patientName },
          { type: 'text', text: date },
          { type: 'text', text: time },
          { type: 'text', text: appointment.clinic?.name ?? '' },
        ],
      },
    ];
  }
}
