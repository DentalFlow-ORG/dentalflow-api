# Cross-site auth, refresh cookie, and CSRF posture

**Updated:** 2026-09-20 (source review; deployment topology below is a configuration reference, not a live verification).

## Deployment topology (why this matters)

The SPA and the API are served from **different registrable domains**:

- Frontend (SPA): `https://dentalflow-web-teal.vercel.app` (Vercel)
- API: `https://dentalflow-api.onrender.com` (Render)

`vercel.app` and `onrender.com` are different sites, so every browser call from
the SPA to the API is **cross-site**. This single fact drives the cookie and
CSRF design below. (In local development both run on `localhost` — same-site —
so the rules relax automatically.)

## Token model

- **Access token** — short-lived JWT (15 min), returned in the response **body**
  and sent by the SPA in the `Authorization: Bearer` header. It is held only in
  JS memory on the client. Bearer-header auth is immune to CSRF.
- **Refresh token** — opaque random token, SHA-256-hashed at rest, delivered in
  an **HttpOnly cookie** scoped to `path=/api/auth`, rotated on every use with
  reuse-detection. Only `/api/auth/refresh` and `/api/auth/logout` read it.

## Refresh cookie attributes

Set in `src/modules/auth/auth.controller.ts` (`refreshCookieOptions`):

| Attribute | Production | Local dev | Reason |
|-----------|-----------|-----------|--------|
| `HttpOnly` | yes | yes | Not readable by JS (XSS can't steal it). |
| `Secure` | yes | no | Required by `SameSite=None`; dev is HTTP localhost. |
| `SameSite` | `None` | `Lax` | **Cross-site** in prod: a `Lax`/`Strict` cookie is **not** sent on the cross-site `fetch` to `/api/auth/refresh`, so silent refresh would break. `None` lets the browser send it. |
| `Path` | `/api/auth` | `/api/auth` | Cookie travels to the auth path prefix; only refresh/logout consume it. |

> ⚠️ **Do not change `SameSite` to `Strict` or `Lax` while the API and SPA are on
> different domains.** It will silently break refresh (users get logged out when
> the access token expires / on reload). `Strict`/`Lax` are only viable if the
> API is moved to a subdomain of the SPA's registrable domain (same-site).

## CSRF protection

`SameSite=None` gives up SameSite's built-in CSRF defense, so the two
cookie-authenticated, state-changing routes validate the request **`Origin`**
against the configured allowlist (`appConfig.frontendOrigins`, from
`FRONTEND_ORIGIN`):

- `src/common/utils/origin-allowlist.ts` — `isTrustedOrigin(origin, allowlist)`
- `AuthController.assertTrustedOrigin()` is called at the top of `refresh()` and
  `logout()`.

Rules:

- A request whose `Origin` is **present and not allow-listed** → `403`.
- A request with **no `Origin`** header is allowed: browsers always send `Origin`
  on cross-origin (and modern same-origin) state-changing requests; non-browser
  callers that omit it still need a valid cookie/JWT and cannot be the vehicle of
  a browser-driven CSRF attack.

Every other state-changing endpoint authenticates with the `Authorization`
header (not the cookie) and is therefore CSRF-immune regardless of SameSite.

## CORS

`src/bootstrap/configure-app.ts` allow-lists exact origins from `FRONTEND_ORIGIN` (no wildcard),
sets `credentials: true`, and restricts methods/headers. `validate-env.ts`
enforces HTTPS-only, non-`*` origins in production. The allow-list backing CORS
is the same one backing the CSRF `Origin` check.

## Frontend CSP coupling

The SPA's CSP (`vercel.json` in `dentalflow-web`) must keep this API origin in
`connect-src`:

```
connect-src 'self' https://dentalflow-api.onrender.com
```

If the API origin changes, update **both** `FRONTEND_ORIGIN`/`VITE_API_URL`
**and** the CSP `connect-src`, or the browser will block API calls.

## Required environment variables (recap)

Production fails fast (`validate-env.ts`) if any of these are missing:
`JWT_SECRET`, `DATABASE_URL`, `DIRECT_URL`, `FRONTEND_ORIGIN` (HTTPS, no `*`),
`FRONTEND_URL` (HTTPS), `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`STRIPE_SUCCESS_URL`, `STRIPE_CANCEL_URL`, `STRIPE_PORTAL_RETURN_URL`,
`GOOGLE_CALENDAR_CLIENT_ID/SECRET/REDIRECT_URI/TOKEN_SECRET`, and `OPENAI_API_KEY`
(unless `OPENAI_AI_ASSISTANT_ENABLED=false`).

## Release limitations

HttpOnly blocks JavaScript reading the cookie; XSS can still act as the user.
SameSite=None does not override browser third-party-cookie blocking. Verify
reload and expiry on supported browsers; consider same-site custom domains.
The cookie Path follows API_PREFIX and covers the whole auth prefix.
WHATSAPP_VERIFY_TOKEN is also required at boot; enabled real production WhatsApp
requires provider settings and WHATSAPP_APP_SECRET (or its legacy alias).
Logout also requires a valid Bearer token. Current findings and release checks:
[security](../../../dentalflow-web/docs/security/security-hardening-report.md)
and [production](../../../dentalflow-web/docs/deployment/production-readiness.md).
