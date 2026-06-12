/**
 * CSRF defense for cookie-authenticated endpoints.
 *
 * The refresh-token cookie uses SameSite=None in production because the SPA
 * (Vercel) and the API (Render) are served from different registrable domains,
 * so the browser would otherwise drop the cookie on cross-site requests.
 * SameSite=None gives up SameSite's built-in CSRF protection, so the
 * cookie-authenticated refresh/logout routes additionally validate the request
 * Origin against the configured allowlist.
 *
 * A missing Origin header is treated as trusted: browsers always send Origin on
 * cross-origin (and modern same-origin) state-changing requests, while
 * legitimate non-browser callers (health checks, server-to-server) omit it and
 * cannot be the vehicle for a browser-driven CSRF attack.
 */
export function isTrustedOrigin(
  origin: string | undefined,
  allowlist: readonly string[],
): boolean {
  if (!origin) {
    return true;
  }
  return allowlist.includes(origin);
}
