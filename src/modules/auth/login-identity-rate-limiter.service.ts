import { HttpException, HttpStatus, Injectable } from '@nestjs/common';

// DEPLOYMENT NOTE — in-memory store:
// Failure counters are held in a Map on the NestJS process heap.
// Single-instance (MVP): fully effective — all requests share the same map.
// Multi-instance / horizontally scaled: each instance maintains its own counters,
// so a determined attacker can bypass the limit by spreading requests across instances.
// Mitigation for multi-instance production: replace the Map with a shared Redis store
// (e.g. ioredis + sliding-window counter) before scaling beyond one instance.

const LOGIN_IDENTITY_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_IDENTITY_MAX_FAILURES = 8;

export class LoginIdentityRateLimitExceededException extends HttpException {
  constructor() {
    super(
      'Muitas tentativas de login. Tente novamente em alguns minutos.',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}

type AttemptBucket = {
  failures: number;
  resetAt: number;
};

@Injectable()
export class LoginIdentityRateLimiterService {
  private readonly attempts = new Map<string, AttemptBucket>();

  assertCanAttempt(emailHash: string): void {
    this.pruneExpired();

    const bucket = this.attempts.get(this.buildKey(emailHash));
    if (!bucket) return;

    if (bucket.failures >= LOGIN_IDENTITY_MAX_FAILURES) {
      throw new LoginIdentityRateLimitExceededException();
    }
  }

  recordFailure(emailHash: string): void {
    const key = this.buildKey(emailHash);
    const now = Date.now();
    const current = this.attempts.get(key);

    if (!current || current.resetAt <= now) {
      this.attempts.set(key, {
        failures: 1,
        resetAt: now + LOGIN_IDENTITY_WINDOW_MS,
      });
      return;
    }

    current.failures += 1;
  }

  reset(emailHash: string): void {
    this.attempts.delete(this.buildKey(emailHash));
  }

  private buildKey(emailHash: string): string {
    return `login:emailHash:${emailHash}`;
  }

  private pruneExpired(): void {
    const now = Date.now();
    for (const [key, bucket] of this.attempts.entries()) {
      if (bucket.resetAt <= now) {
        this.attempts.delete(key);
      }
    }
  }
}

export const loginIdentityRateLimitConfig = {
  windowMs: LOGIN_IDENTITY_WINDOW_MS,
  maxFailures: LOGIN_IDENTITY_MAX_FAILURES,
  store: 'memory',
} as const;
