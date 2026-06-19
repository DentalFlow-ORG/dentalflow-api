import { isTrustedOrigin } from './origin-allowlist';

describe('isTrustedOrigin', () => {
  const allowlist = ['https://app.example.com', 'https://www.example.com'];

  it('treats a missing Origin header as trusted (non-browser / server-to-server)', () => {
    expect(isTrustedOrigin(undefined, allowlist)).toBe(true);
  });

  it('allows an Origin present in the allowlist', () => {
    expect(isTrustedOrigin('https://app.example.com', allowlist)).toBe(true);
  });

  it('rejects an Origin that is not in the allowlist', () => {
    expect(isTrustedOrigin('https://evil.example', allowlist)).toBe(false);
  });

  it('requires an exact scheme/host match (no downgrade to http)', () => {
    expect(isTrustedOrigin('http://app.example.com', allowlist)).toBe(false);
  });

  it('rejects any present Origin when the allowlist is empty', () => {
    expect(isTrustedOrigin('https://app.example.com', [])).toBe(false);
  });
});
