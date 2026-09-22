import { assertLocalDemoSeed } from './seed-safety';

describe('demo seed safety', () => {
  it.each(['production', 'staging'])(
    'rejects %s even on localhost',
    (environment) => {
      expect(() =>
        assertLocalDemoSeed(
          environment,
          'postgresql://test@localhost:5433/test',
        ),
      ).toThrow();
    },
  );
  it.each([
    'postgresql://user@remote.example/db',
    'invalid',
    'postgresql://user@localhost.attacker.example/db',
  ])('rejects non-local destination %s', (url) => {
    expect(() => assertLocalDemoSeed('development', url)).toThrow();
  });
  it.each(['localhost', '127.0.0.1', '[::1]'])(
    'permits explicit local development on %s',
    (host) => {
      expect(() =>
        assertLocalDemoSeed(
          'development',
          'postgresql://test@' + host + ':5433/test',
        ),
      ).not.toThrow();
    },
  );
});
