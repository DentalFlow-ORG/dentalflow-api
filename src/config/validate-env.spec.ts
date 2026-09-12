/**
 * Environment validation is a production safety net: it is the difference
 * between a deploy that refuses to start and one that starts with, say, no
 * Stripe webhook secret and silently drops every billing event.
 *
 * `validate-env.ts` reads `NODE_ENV` at module load to decide which rules are
 * required, so each case re-imports the module inside an isolated registry
 * with the environment already set.
 */

const BASE_REQUIRED = {
  JWT_SECRET: 'secret',
  DATABASE_URL: 'postgresql://localhost:5432/db',
  WHATSAPP_VERIFY_TOKEN: 'verify-token',
};

const PRODUCTION_REQUIRED = {
  ...BASE_REQUIRED,
  DIRECT_URL: 'postgresql://localhost:5432/db',
  FRONTEND_ORIGIN: 'https://app.dentalflow.com.br',
  FRONTEND_URL: 'https://app.dentalflow.com.br',
  STRIPE_SECRET_KEY: 'sk_test',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
  STRIPE_SUCCESS_URL: 'https://app.dentalflow.com.br/ok',
  STRIPE_CANCEL_URL: 'https://app.dentalflow.com.br/cancel',
  STRIPE_PORTAL_RETURN_URL: 'https://app.dentalflow.com.br/portal',
  GOOGLE_CALENDAR_CLIENT_ID: 'google-client',
  GOOGLE_CALENDAR_CLIENT_SECRET: 'google-secret',
  GOOGLE_CALENDAR_REDIRECT_URI: 'https://api.dentalflow.com.br/callback',
  GOOGLE_CALENDAR_TOKEN_SECRET: 'token-secret',
  OPENAI_API_KEY: 'sk-openai',
};

/** Runs validateEnv() against exactly the supplied environment. */
function runValidation(env: Record<string, string | undefined>): () => void {
  let validate!: () => void;

  jest.isolateModules(() => {
    const original = process.env;
    process.env = { ...env } as NodeJS.ProcessEnv;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const loaded = require('./validate-env') as typeof import('./validate-env');
      const run = loaded.validateEnv;
      validate = () => {
        const outer = process.env;
        process.env = { ...env } as NodeJS.ProcessEnv;
        try {
          run();
        } finally {
          process.env = outer;
        }
      };
    } finally {
      process.env = original;
    }
  });

  return validate;
}

describe('validateEnv', () => {
  describe('development', () => {
    const dev = (extra: Record<string, string | undefined> = {}) => ({
      NODE_ENV: 'development',
      ...BASE_REQUIRED,
      ...extra,
    });

    it('accepts the minimum development environment', () => {
      expect(runValidation(dev())).not.toThrow();
    });

    it.each(Object.keys(BASE_REQUIRED))(
      'rejects a missing %s even outside production',
      (key) => {
        expect(runValidation(dev({ [key]: undefined }))).toThrow(key);
      },
    );

    it('names every missing variable at once rather than one per restart', () => {
      const run = runValidation({ NODE_ENV: 'development' });
      expect(run).toThrow(/JWT_SECRET[\s\S]*DATABASE_URL[\s\S]*WHATSAPP_VERIFY_TOKEN/);
    });

    it('includes a description alongside each missing variable', () => {
      expect(runValidation(dev({ DATABASE_URL: undefined }))).toThrow(
        /PostgreSQL connection string/,
      );
    });

    it('labels the failure with the environment it validated', () => {
      expect(runValidation(dev({ JWT_SECRET: undefined }))).toThrow(/\(development\)/);
    });

    it('does not require production-only variables', () => {
      expect(runValidation(dev())).not.toThrow();
    });

    it('treats an empty string as missing', () => {
      expect(runValidation(dev({ JWT_SECRET: '' }))).toThrow('JWT_SECRET');
    });
  });

  describe('production', () => {
    const prod = (extra: Record<string, string | undefined> = {}) => ({
      NODE_ENV: 'production',
      ...PRODUCTION_REQUIRED,
      ...extra,
    });

    it('accepts a complete production environment', () => {
      expect(runValidation(prod())).not.toThrow();
    });

    it.each([
      'DIRECT_URL',
      'FRONTEND_ORIGIN',
      'FRONTEND_URL',
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_SUCCESS_URL',
      'STRIPE_CANCEL_URL',
      'STRIPE_PORTAL_RETURN_URL',
      'GOOGLE_CALENDAR_CLIENT_ID',
      'GOOGLE_CALENDAR_CLIENT_SECRET',
      'GOOGLE_CALENDAR_REDIRECT_URI',
      'GOOGLE_CALENDAR_TOKEN_SECRET',
    ])('requires %s in production', (key) => {
      expect(runValidation(prod({ [key]: undefined }))).toThrow(key);
    });

    it('labels the failure as production', () => {
      expect(runValidation(prod({ STRIPE_SECRET_KEY: undefined }))).toThrow(
        /\(production\)/,
      );
    });

    describe('OpenAI', () => {
      it('requires OPENAI_API_KEY when the AI assistant is not explicitly disabled', () => {
        expect(runValidation(prod({ OPENAI_API_KEY: undefined }))).toThrow(
          'OPENAI_API_KEY',
        );
      });

      it('allows a missing key when the assistant is disabled', () => {
        expect(
          runValidation(
            prod({ OPENAI_API_KEY: undefined, OPENAI_AI_ASSISTANT_ENABLED: 'false' }),
          ),
        ).not.toThrow();
      });

      it('still requires the key for any value other than the literal "false"', () => {
        expect(
          runValidation(
            prod({ OPENAI_API_KEY: undefined, OPENAI_AI_ASSISTANT_ENABLED: 'true' }),
          ),
        ).toThrow('OPENAI_API_KEY');
      });
    });

    describe('HTTPS and origin hardening', () => {
      it('rejects a non-HTTPS FRONTEND_URL', () => {
        expect(runValidation(prod({ FRONTEND_URL: 'http://app.dentalflow.com.br' }))).toThrow(
          /HTTPS/,
        );
      });

      it('rejects a wildcard CORS origin', () => {
        expect(runValidation(prod({ FRONTEND_ORIGIN: '*' }))).toThrow(
          /explicit HTTPS origins/,
        );
      });

      it('rejects a non-HTTPS origin in the allowlist', () => {
        expect(
          runValidation({
            ...prod(),
            FRONTEND_ORIGIN: 'https://app.dentalflow.com.br,http://localhost:5173',
          }),
        ).toThrow(/explicit HTTPS origins/);
      });

      it('accepts several HTTPS origins', () => {
        expect(
          runValidation({
            ...prod(),
            FRONTEND_ORIGIN: 'https://app.dentalflow.com.br, https://www.dentalflow.com.br',
          }),
        ).not.toThrow();
      });

      it('rejects an origin list that is only separators', () => {
        expect(runValidation(prod({ FRONTEND_ORIGIN: ' , , ' }))).toThrow(
          /FRONTEND_ORIGIN is required/,
        );
      });
    });

    describe('WhatsApp Cloud API', () => {
      const whatsappEnabled = {
        NOTIFICATION_PROVIDER: 'whatsapp_cloud',
        WHATSAPP_CLOUD_API_ENABLED: 'true',
        WHATSAPP_CLOUD_API_VERSION: 'v21.0',
        WHATSAPP_CLOUD_PHONE_NUMBER_ID: '123',
        WHATSAPP_CLOUD_ACCESS_TOKEN: 'token',
        WHATSAPP_DEFAULT_LANGUAGE: 'pt_BR',
        WHATSAPP_APP_SECRET: 'app-secret',
      };

      it('accepts a fully configured WhatsApp Cloud setup', () => {
        expect(runValidation(prod(whatsappEnabled))).not.toThrow();
      });

      it('does not demand WhatsApp Cloud variables for the local provider', () => {
        expect(
          runValidation(prod({ NOTIFICATION_PROVIDER: 'local' })),
        ).not.toThrow();
      });

      it('does not demand them when the provider is selected but not enabled', () => {
        expect(
          runValidation(prod({ NOTIFICATION_PROVIDER: 'whatsapp_cloud' })),
        ).not.toThrow();
      });

      it.each([
        'WHATSAPP_CLOUD_API_VERSION',
        'WHATSAPP_CLOUD_PHONE_NUMBER_ID',
        'WHATSAPP_CLOUD_ACCESS_TOKEN',
        'WHATSAPP_DEFAULT_LANGUAGE',
      ])('requires %s once WhatsApp Cloud sending is enabled', (key) => {
        expect(
          runValidation(prod({ ...whatsappEnabled, [key]: undefined })),
        ).toThrow(key);
      });

      it('requires a webhook app secret so payload signatures can be verified', () => {
        expect(
          runValidation(prod({ ...whatsappEnabled, WHATSAPP_APP_SECRET: undefined })),
        ).toThrow('WHATSAPP_APP_SECRET');
      });

      it('accepts WHATSAPP_WEBHOOK_APP_SECRET as the alternative name', () => {
        expect(
          runValidation(
            prod({
              ...whatsappEnabled,
              WHATSAPP_APP_SECRET: undefined,
              WHATSAPP_WEBHOOK_APP_SECRET: 'webhook-secret',
            }),
          ),
        ).not.toThrow();
      });
    });
  });

  describe('Google sign-in', () => {
    const googleEnabled = {
      GOOGLE_AUTH_ENABLED: 'true',
      GOOGLE_CLIENT_ID: 'client',
      GOOGLE_CLIENT_SECRET: 'secret',
      GOOGLE_CALLBACK_URL: 'https://api.dentalflow.com.br/auth/google/callback',
      FRONTEND_AUTH_SUCCESS_URL: 'https://app.dentalflow.com.br/ok',
      FRONTEND_AUTH_COMPLETE_PROFILE_URL: 'https://app.dentalflow.com.br/complete',
      FRONTEND_ORIGIN: 'https://app.dentalflow.com.br',
    };

    const devGoogle = (extra: Record<string, string | undefined> = {}) => ({
      NODE_ENV: 'development',
      ...BASE_REQUIRED,
      ...googleEnabled,
      ...extra,
    });

    it('ignores Google sign-in configuration when the feature is off', () => {
      expect(
        runValidation({ NODE_ENV: 'development', ...BASE_REQUIRED }),
      ).not.toThrow();
    });

    it('only activates for the literal "true"', () => {
      expect(
        runValidation({
          NODE_ENV: 'development',
          ...BASE_REQUIRED,
          GOOGLE_AUTH_ENABLED: 'yes',
        }),
      ).not.toThrow();
    });

    it.each([
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'GOOGLE_CALLBACK_URL',
      'FRONTEND_AUTH_SUCCESS_URL',
      'FRONTEND_AUTH_COMPLETE_PROFILE_URL',
    ])('requires %s once Google sign-in is enabled', (key) => {
      expect(runValidation(devGoogle({ [key]: undefined }))).toThrow(key);
    });

    it('accepts a complete Google sign-in configuration', () => {
      expect(runValidation(devGoogle())).not.toThrow();
    });

    it('rejects a redirect URL pointing outside the CORS allowlist', () => {
      // An attacker-controlled redirect origin would receive the session.
      expect(
        runValidation(
          devGoogle({ FRONTEND_AUTH_SUCCESS_URL: 'https://evil.example/ok' }),
        ),
      ).toThrow(/origin listed in FRONTEND_ORIGIN/);
    });

    it('allows any redirect origin when no allowlist is configured', () => {
      expect(
        runValidation(devGoogle({ FRONTEND_ORIGIN: undefined })),
      ).not.toThrow();
    });

    it('requires HTTPS redirect URLs in production', () => {
      expect(
        runValidation({
          ...PRODUCTION_REQUIRED,
          NODE_ENV: 'production',
          ...googleEnabled,
          GOOGLE_CALLBACK_URL: 'http://api.dentalflow.com.br/callback',
        }),
      ).toThrow(/HTTPS in production/);
    });

    it('requires an HTTPS complete-profile URL in production', () => {
      expect(
        runValidation({
          ...PRODUCTION_REQUIRED,
          NODE_ENV: 'production',
          ...googleEnabled,
          FRONTEND_AUTH_COMPLETE_PROFILE_URL: 'http://app.dentalflow.com.br/complete',
        }),
      ).toThrow(/HTTPS in production/);
    });

    it('accepts HTTPS redirect URLs in production', () => {
      expect(
        runValidation({
          ...PRODUCTION_REQUIRED,
          NODE_ENV: 'production',
          ...googleEnabled,
        }),
      ).not.toThrow();
    });
  });
});
