import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  async sendPasswordResetEmail(_to: string, rawToken: string): Promise<void> {
    if (process.env.NODE_ENV !== 'production') {
      // Safe for local/test: logs the raw token so developers can test the flow without a real inbox.
      this.logger.log(`[DEV] Password reset token: ${rawToken}`);
      return;
    }

    // Production: no provider configured yet. Log a warning without the token.
    this.logger.warn(
      'MailService.sendPasswordResetEmail: no email provider configured — email not sent. ' +
        'Wire a real provider (Resend, Nodemailer, etc.) in MailService.',
    );
  }
}
