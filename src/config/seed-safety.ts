/** Demo accounts must never be provisioned into a hosted database. */
export function assertLocalDemoSeed(
  environment: string | undefined,
  connectionString: string,
): void {
  if (environment !== 'development' && environment !== 'test') {
    throw new Error(
      'Demo seed requires explicit NODE_ENV=development or test.',
    );
  }
  const url = new URL(connectionString);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  ) {
    throw new Error(
      'Demo seed is restricted to a disposable local PostgreSQL database.',
    );
  }
}
