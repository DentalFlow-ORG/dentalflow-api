import {
  LoginIdentityRateLimitExceededException,
  LoginIdentityRateLimiterService,
  loginIdentityRateLimitConfig,
} from './login-identity-rate-limiter.service';

describe('LoginIdentityRateLimiterService', () => {
  let service: LoginIdentityRateLimiterService;
  const HASH = 'test-email-hash';

  beforeEach(() => {
    service = new LoginIdentityRateLimiterService();
  });

  describe('assertCanAttempt', () => {
    it('allows when no bucket exists for the hash', () => {
      expect(() => service.assertCanAttempt(HASH)).not.toThrow();
    });

    it('allows when failures are below the max threshold', () => {
      for (let i = 0; i < loginIdentityRateLimitConfig.maxFailures - 1; i++) {
        service.recordFailure(HASH);
      }
      expect(() => service.assertCanAttempt(HASH)).not.toThrow();
    });

    it('throws LoginIdentityRateLimitExceededException at exactly max failures', () => {
      for (let i = 0; i < loginIdentityRateLimitConfig.maxFailures; i++) {
        service.recordFailure(HASH);
      }
      expect(() => service.assertCanAttempt(HASH)).toThrow(
        LoginIdentityRateLimitExceededException,
      );
    });

    it('exception carries HTTP 429 status', () => {
      for (let i = 0; i < loginIdentityRateLimitConfig.maxFailures; i++) {
        service.recordFailure(HASH);
      }
      try {
        service.assertCanAttempt(HASH);
        throw new Error('Expected exception not thrown');
      } catch (err) {
        expect((err as LoginIdentityRateLimitExceededException).getStatus()).toBe(429);
      }
    });

    it('continues to throw on every subsequent call once locked out', () => {
      for (let i = 0; i < loginIdentityRateLimitConfig.maxFailures; i++) {
        service.recordFailure(HASH);
      }
      expect(() => service.assertCanAttempt(HASH)).toThrow();
      expect(() => service.assertCanAttempt(HASH)).toThrow();
      expect(() => service.assertCanAttempt(HASH)).toThrow();
    });

    it('allows again after the window expires', () => {
      jest.useFakeTimers();
      try {
        for (let i = 0; i < loginIdentityRateLimitConfig.maxFailures; i++) {
          service.recordFailure(HASH);
        }
        expect(() => service.assertCanAttempt(HASH)).toThrow();

        jest.advanceTimersByTime(loginIdentityRateLimitConfig.windowMs + 1);

        expect(() => service.assertCanAttempt(HASH)).not.toThrow();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('recordFailure', () => {
    it('creates a new bucket on the first failure (below threshold)', () => {
      service.recordFailure(HASH);
      expect(() => service.assertCanAttempt(HASH)).not.toThrow();
    });

    it('accumulates failures until the threshold is reached', () => {
      for (let i = 0; i < loginIdentityRateLimitConfig.maxFailures - 1; i++) {
        service.recordFailure(HASH);
      }
      expect(() => service.assertCanAttempt(HASH)).not.toThrow();

      service.recordFailure(HASH);
      expect(() => service.assertCanAttempt(HASH)).toThrow(
        LoginIdentityRateLimitExceededException,
      );
    });

    it('resets the counter to 1 when called after the window has elapsed', () => {
      jest.useFakeTimers();
      try {
        for (let i = 0; i < loginIdentityRateLimitConfig.maxFailures; i++) {
          service.recordFailure(HASH);
        }
        jest.advanceTimersByTime(loginIdentityRateLimitConfig.windowMs + 1);

        service.recordFailure(HASH);
        expect(() => service.assertCanAttempt(HASH)).not.toThrow();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('reset', () => {
    it('clears the bucket so the next assertCanAttempt passes', () => {
      for (let i = 0; i < loginIdentityRateLimitConfig.maxFailures; i++) {
        service.recordFailure(HASH);
      }
      expect(() => service.assertCanAttempt(HASH)).toThrow();

      service.reset(HASH);

      expect(() => service.assertCanAttempt(HASH)).not.toThrow();
    });

    it('is a no-op when no bucket exists for the hash', () => {
      expect(() => service.reset('nonexistent-hash')).not.toThrow();
    });
  });

  describe('bucket isolation', () => {
    it('buckets for different hashes are independent', () => {
      const hashA = 'hash-a';
      const hashB = 'hash-b';

      for (let i = 0; i < loginIdentityRateLimitConfig.maxFailures; i++) {
        service.recordFailure(hashA);
      }

      expect(() => service.assertCanAttempt(hashA)).toThrow();
      expect(() => service.assertCanAttempt(hashB)).not.toThrow();
    });

    it('resetting one hash does not unlock a different locked hash', () => {
      const hashA = 'hash-a';
      const hashB = 'hash-b';

      for (let i = 0; i < loginIdentityRateLimitConfig.maxFailures; i++) {
        service.recordFailure(hashA);
        service.recordFailure(hashB);
      }

      service.reset(hashA);

      expect(() => service.assertCanAttempt(hashA)).not.toThrow();
      expect(() => service.assertCanAttempt(hashB)).toThrow();
    });
  });
});
