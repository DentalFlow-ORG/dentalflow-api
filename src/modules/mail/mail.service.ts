import { Injectable, Logger } from '@nestjs/common';
import { Resend } from 'resend';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  async sendPasswordResetEmail(to: string, rawToken: string): Promise<void> {
    const apiKey = process.env.RESEND_API_KEY;
    const frontendUrl = (
      process.env.FRONTEND_URL ?? 'http://localhost:5173'
    ).replace(/\/$/, '');
    const isProduction = process.env.NODE_ENV === 'production';

    // ── No provider configured ──────────────────────────────────────────────
    if (!apiKey) {
      if (!isProduction) {
        const resetLink = `${frontendUrl}/recuperar-senha/redefinir?token=${rawToken}`;
        this.logger.log(`[DEV] Password reset link: ${resetLink}`);
      } else {
        this.logger.warn(
          'MailService: RESEND_API_KEY is not configured — password reset email not sent.',
        );
      }
      return;
    }

    const mailFrom = process.env.MAIL_FROM;
    if (!mailFrom) {
      this.logger.warn(
        'MailService: MAIL_FROM is not configured — password reset email not sent. ' +
          'Set MAIL_FROM in your environment (e.g. "DentalFlow <no-reply@your-domain.com>").',
      );
      return;
    }

    // ── Send via Resend ─────────────────────────────────────────────────────
    const resetLink = `${frontendUrl}/recuperar-senha/redefinir?token=${rawToken}`;
    const resend = new Resend(apiKey);

    try {
      const { error } = await resend.emails.send({
        from: mailFrom,
        to,
        subject: 'Redefinição de senha — DentalFlow',
        html: buildResetEmailHtml(resetLink),
        text: buildResetEmailText(resetLink),
      });

      if (error) {
        // Log Resend's own error details — never includes token or recipient PII
        this.logger.error(
          `MailService: failed to send password reset email — ${error.name}: ${error.message}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `MailService: unexpected error sending password reset email — ${message}`,
      );
    }
  }
}

// ── Email template builders ───────────────────────────────────────────────────

function buildResetEmailHtml(resetLink: string): string {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Redefinição de senha — DentalFlow</title>
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;-webkit-font-smoothing:antialiased;">
  <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background:#f8fafc;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="max-width:520px;">

          <tr>
            <td style="padding-bottom:24px;text-align:center;">
              <span style="font-size:20px;font-weight:700;color:#1e3a8a;letter-spacing:-0.3px;">DentalFlow</span>
            </td>
          </tr>

          <tr>
            <td style="background:#ffffff;border:1px solid #e2e8f0;border-radius:12px;padding:40px 36px;">
              <p style="margin:0 0 8px;font-size:22px;font-weight:600;color:#0f172a;line-height:1.3;">
                Redefinição de senha
              </p>
              <p style="margin:0 0 28px;font-size:14px;color:#475569;line-height:1.65;">
                Recebemos uma solicitação para redefinir a senha da sua conta no DentalFlow.
                Clique no botão abaixo para criar uma nova senha.
              </p>

              <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td align="center" style="padding-bottom:28px;">
                    <a href="${resetLink}"
                       style="display:inline-block;background:#1e3a8a;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:14px 32px;border-radius:8px;line-height:1;">
                      Redefinir senha
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:0 0 8px;font-size:13px;color:#64748b;line-height:1.5;">
                Se o botão não funcionar, copie e cole este link no navegador:
              </p>
              <p style="margin:0 0 28px;font-size:12px;color:#94a3b8;word-break:break-all;line-height:1.6;">
                ${resetLink}
              </p>

              <hr style="border:none;border-top:1px solid #f1f5f9;margin:0 0 24px;" />

              <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.7;">
                Este link expira em <strong>1 hora</strong>.<br />
                Se você não solicitou a redefinição de senha, ignore este e-mail.
                Sua senha permanece a mesma.
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding-top:20px;text-align:center;">
              <p style="margin:0;font-size:12px;color:#94a3b8;">
                © DentalFlow · Enviado automaticamente, não responda este e-mail.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildResetEmailText(resetLink: string): string {
  return [
    'Redefinição de senha — DentalFlow',
    '',
    'Recebemos uma solicitação para redefinir a senha da sua conta no DentalFlow.',
    '',
    'Acesse o link abaixo para criar uma nova senha:',
    resetLink,
    '',
    'Este link expira em 1 hora.',
    '',
    'Se você não solicitou a redefinição de senha, ignore este e-mail.',
    'Sua senha permanece a mesma.',
    '',
    '— DentalFlow',
  ].join('\n');
}
