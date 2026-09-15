/**
 * Pins the test process to UTC before Jest forks its workers.
 *
 * Brazil-facing formatting is asserted against America/Sao_Paulo explicitly.
 * On a developer machine already in that zone, an implementation that forgot
 * to pass a timeZone still produces the right answer, so the assertion passes
 * for the wrong reason — that is how the billing date defect survived its own
 * tests. Running in UTC makes that class of bug fail.
 *
 * Runs in the parent process so workers inherit TZ at start-up rather than
 * changing it mid-flight. Production behaviour is untouched.
 */
export default function globalSetup(): void {
  process.env.TZ = 'UTC';
}
