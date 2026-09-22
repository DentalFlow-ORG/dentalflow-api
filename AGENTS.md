# DentalFlow — Backend Instructions

Authoritative instructions for anyone — human or agent — working in this
repository. `CLAUDE.md` points here; keep the two consistent by editing this
file, not by duplicating it.

Role: **Senior Backend Engineer.**

---

## 1. Stack

NestJS 11 · TypeScript · Prisma 7 · PostgreSQL · Stripe · Jest · Bun.

Multi-tenant SaaS. A clinic is the tenant. Roles are `ADMIN` (platform),
`OWNER`, `DENTIST`, `ASSISTANT` (clinic) and `PATIENT` (a transient onboarding
role — see §5).

---

## 2. Package manager

This project uses **Bun**. Never `npm`, `pnpm` or `yarn`. If a command fails
under Bun, fix the script rather than reaching for another package manager.

```
bun install                # install dependencies
bun run <script>           # run a package.json script
bun add <pkg>              # add a dependency
bun remove <pkg>           # remove a dependency
bunx prisma generate       # Prisma CLI
bunx prisma migrate deploy
bunx ts-node <script>      # one-off TypeScript scripts
```

---

## 3. Commands

| Purpose                       | Command                    |
| ----------------------------- | -------------------------- |
| Type check                    | `bun run typecheck`        |
| Lint (**validation**)         | `bun run lint:check`       |
| Lint (mutating)               | `bun run lint`             |
| Unit tests (no database)      | `bun run test`             |
| Coverage                      | `bun run test:cov`         |
| Start the disposable database | `bun run test:db:up`       |
| Migration history from zero   | `bun run test:migrations`  |
| Integration (needs that DB)   | `bun run test:integration` |
| E2E (needs that DB)           | `bun run test:e2e`         |
| Stop and delete that DB       | `bun run test:db:down`     |
| Dead-code analysis            | `bun run deadcode`         |
| Prisma schema check           | `bun run prisma:validate`  |
| Build                         | `bun run build`            |
| Everything                    | `bun run verify`           |

`bun run lint` runs `eslint --fix` and **rewrites files**. Never use it as a
validation step or in CI. Use `lint:check`.

`lint:check` passes. The Prettier backlog it used to report was cleared in a
single formatting-only commit and the CI lint job is now blocking, so any
finding is a new one — fix it rather than adding to a backlog that no longer
exists. The `no-unsafe-*` family and `unbound-method` are off **in test files
only**, because a jest mock is `any` by construction; production source keeps
every one of them.

---

## 4. Architecture

```
controllers → HTTP shape only
services    → business logic
modules     → domain boundary
```

Never put logic in a controller. A controller resolves the caller's scope
through `AccessPolicyService` and delegates.

Global guards run in this order, declared in `app.module.ts`:

```
ThrottlerGuard → JwtAuthGuard → TenantGuard → RolesGuard
              → BillingAccessGuard → PlanFeatureGuard
```

`RolesGuard` throws when a route declares no policy at all, so every endpoint
must carry `@Roles(...)`, `@AnyAuthenticated()` or `@Public()`.

---

## 5. Roles and tenancy

- `ADMIN` has `clinicId === null` and crosses tenants **only** through
  explicitly ADMIN-only endpoints.
- `OWNER`, `DENTIST`, `ASSISTANT` must have a `clinicId`.
- `PATIENT` has `clinicId === null`. It exists only between Google sign-up and
  `/auth/complete-profile`; password login rejects it. It may reach the
  identity and onboarding endpoints and nothing else.

`AccessPolicyService.assertValidRoleTenantShape` enforces these invariants and
runs on every authenticated request via `JwtStrategy`.

---

## 6. Permanent rules

These are not suggestions. Work that breaks one is not finished.

### New endpoint

Adding or changing an endpoint requires, as applicable:

- a controller test,
- a service/domain test,
- a validation test for the DTO,
- an authorization test covering an allowed **and** a denied role,
- a tenant-isolation test when the endpoint touches clinic data,
- an integration test when database behaviour matters.

It also requires updating `test/support/route-access-matrix.ts`. The frozen
matrix fails until the new row is added, which is the point: a permission
change must be stated explicitly, not inherited from a decorator nobody read.

### Bugs

Every confirmed bug gets a regression test. Write the failing test first, then
the fix, so the test is known to catch the defect.

### Database

When changing a Prisma query, verify:

- the tenant predicate is present (or the query is on a genuinely global
  table — add it to the exemption list in `tenant-scoping.http.spec.ts` with a
  reason);
- deleted-record semantics (`deletedAt: null` where the model is soft-deleted);
- pagination and ordering are stable;
- date boundaries use the Brazil timezone helpers in
  `common/utils/brazil-timezone.ts`, never raw UTC midnight.

### Permissions

New role behaviour needs both an allowed-role test and a denied-role test.
Never rely on the decorator alone as evidence.

### Multi-tenancy

Any endpoint accepting an entity id must state, explicitly, what happens when
that id belongs to another clinic. Scope the query
(`where: { id, clinicId }`), or fetch and compare before mutating. Answer
**404**, never 403 — a 403 tells the caller the row exists.

### Integrations

Do not rely on mocked Prisma alone for behaviour that depends on constraints,
transactions, relational integrity, unique indexes or real query semantics.
Those need `bun run test:e2e` against a real database (see §8).

### Reuse

Before writing a new policy or helper, search for an existing one.
`AccessPolicyService`, `common/utils/brazil-timezone.ts`,
`common/utils/date-range.utils.ts` and `GlobalExceptionFilter` already cover
most cross-cutting cases.

### Dead code

After replacing or refactoring behaviour, delete what it replaced and run
`bun run deadcode`. Deleting requires evidence — a removed call site, a
superseded flow — not just a tool saying "unused". Framework-discovered Nest
components and exported types are not dead by default.

### Migrations

Never edit a migration that has been applied. Schema changes get a new
migration. Do not create a migration for test convenience or as speculative
optimisation; if one looks necessary, stop and say so first.

### Quality

Work is not complete until the relevant checks pass: typecheck, tests,
coverage, dead-code, Prisma validation, build. `bun run verify` runs them.

Coverage thresholds live in `package.json` under `jest.coverageThreshold` and
fail the run on regression. They are set just below the measured baseline —
close enough to catch a real drop, loose enough that a legitimate refactor
does not trip them.

**Raise them when coverage rises; never lower them to make a build pass.** A
change that genuinely cannot be covered belongs in the D/E/F exceptions
discussed in the review notes, not in a reduced threshold.

### Git

Do not commit or push unless explicitly asked. Commit messages follow
Conventional Commits — `.githooks/commit-msg` enforces it.

### Attribution

**Never add a `Co-Authored-By` trailer to a commit**, for an AI assistant or
anyone else. This project does not use them: the commit author is the author.
The same goes for "Generated with…" footers in commits and pull request
descriptions. Write the message as the engineer making the change would.

---

## 7. Testing

### Layout

- `*.spec.ts` beside the code — unit tests, run by `bun run test`. No database.
- `*.http.spec.ts` — the same runner, but booting the real application over
  HTTP through `test/support/http-harness.ts`. Real routing, real pipes, real
  guards, real filters, with `PrismaService` replaced by an in-memory mock.
- `test/integration/*.int-spec.ts` — `bun run test:integration`. The real
  application over HTTP against **real PostgreSQL**, through
  `test/support/integration-harness.ts`. This is where constraints, cascades,
  transactions, `Decimal`, `@db.Date` and concurrency are proved; a mock
  establishes none of them.
- `test/*.e2e-spec.ts` — `bun run test:e2e`. The application as `main.ts`
  builds it, asserting on the **bootstrap**: security headers, CORS policy,
  body-size limits, route prefix and the global validation pipe.

### The harness

`createHarness()` gives you `prisma` (the mock), `tokenFor(user)` (a genuinely
signed JWT for a registered user), `signRaw()` for malformed/expired tokens,
`__calls()` to inspect the queries a handler issued, and `__reset()`.

`test/support/tenant-store.ts` adds a store that actually evaluates the `where`
clause, so cross-tenant behaviour can be observed rather than inferred.

`createIntegrationHarness()` is the database-backed equivalent. It boots the
real `AppModule` with the same `configureApp()` wiring `main.ts` uses, and
gives you the genuine `PrismaClient`, `tokenFor(user)` and `truncate()`
between tests. Only two things are stubbed, neither under test: the throttler,
so request volume cannot turn an assertion into a 429, and outbound `fetch`,
so no test can reach Stripe, Google, OpenAI or Meta. Build fixtures with
`test/support/factories.ts` — `seedTwoClinics()` gives two subscribed clinics
with owners, dentists, profiles and a platform admin.

### Standards

- Assert on outputs and observable behaviour, not on "a mock was called".
  `expect(repo.save).toHaveBeenCalled()` proves nothing about correctness.
- Mock fidelity matters: a mock that returns what the real client cannot
  produce (`findUniqueOrThrow` resolving null, for instance) manufactures
  failures production will never see and hides ones it will.
- Never mock away the behaviour under test.
- No `.only`, no skipped tests, no `sleep`. Restore fake timers.
- Pair every "is denied" test with an "is allowed" test, so a route cannot pass
  by rejecting everything.
- Prefer typed factories over hand-rolled fixtures repeated per file.

### Standing guardrails

Four suites protect the system-wide invariants. Read the failure message before
changing them — they are usually right.

| Suite                                  | Protects                                            |
| -------------------------------------- | --------------------------------------------------- |
| `route-access-matrix.spec.ts`           | the declared policy of all 200+ routes              |
| `authorization-enforcement.http.spec.ts`| that those policies are actually enforced           |
| `tenant-scoping.http.spec.ts`           | every tenant-scoped query carries a clinic predicate |
| `cross-tenant-isolation.http.spec.ts`   | clinic A cannot read or mutate clinic B's rows      |

---

## 8. Database and integration tests

`bun run test` never touches a database — `test/jest-unit-setup.ts` pins a
fixed fake environment and never reads `.env`.

`test:integration`, `test:e2e` and `test:migrations` do need PostgreSQL.
**Never point any of them at the development `DATABASE_URL`**: it is a shared
Supabase instance holding real clinic data, and a truncating run against it is
unrecoverable.

Nothing infers that URL. All three resolve it through
`test/support/test-database.ts`, which throws unless the host is unambiguously
local, rejects every managed-host marker (Supabase, Neon, RDS, Railway, …) and
refuses a URL identical to `DATABASE_URL`. The guard has its own test,
`test-database.spec.ts`, asserting it rejects this project's exact Supabase
URL shape. Do not weaken it.

```bash
bun run test:db:up          # postgres:16-alpine on 5433, on a named volume
bun run test:migrations     # builds a throwaway DB from the real migrations
bun run test:integration    # applies migrations, then runs *.int-spec.ts
bun run test:e2e            # applies migrations, then runs *.e2e-spec.ts
bun run test:db:down        # stops it and deletes the volume
```

Port 5433 is deliberate: 5432 stays free so this can never collide with a
local development PostgreSQL. `DATABASE_URL_TEST` overrides the URL; the guard
still applies.

### Three commands that are not interchangeable

| Command                     | What it does                                              | Proves the migration history? |
| --------------------------- | --------------------------------------------------------- | ----------------------------- |
| `prisma db push`            | Syncs the database to `schema.prisma`. Writes no migration files and never opens `prisma/migrations`. | **No.** |
| `bun run test:db:reset`     | Destroys the container and its volume, then starts an empty one. | No — it only empties. |
| `prisma migrate deploy`     | Applies every migration in `prisma/migrations` in order.    | **Yes.** This is the only one that does. |

`db push` must never be the evidence that the history is valid. It was the
reason a broken chain survived for months: every local run and every CI job
built its schema from `schema.prisma`, so nothing ever read the migrations.
`bun run test:migrations` (`scripts/check-migrations.ts`) is the gate, and CI
runs it: it creates a throwaway database, applies the full chain with
`migrate deploy`, compares the result against `schema.prisma`, and replays the
corrective migrations over an already-migrated database to prove they are
non-destructive.

`test:integration` and `test:e2e` also build their schema with
`migrate deploy` rather than `db push`. That is not only for fidelity of the
history: two tenancy invariants are raw SQL that Prisma's schema language
cannot express, so `db push` never creates them and the suites were running
against a weaker schema than production —

- `users_one_owner_per_clinic_idx`, a partial unique index allowing one active
  OWNER per clinic;
- `users_role_clinic_scope_check`, requiring ADMIN and PATIENT to carry no
  clinic and OWNER, DENTIST and ASSISTANT to carry one.

`bun run test:db:push` remains available as a developer escape hatch for fast
schema iteration. It is not a validation step.

### The leads-removal defect (fixed)

`20260604230209_remove_internal_leads` could not apply to an empty database.
It had two faults:

1. It targeted snake_case identifiers that never existed — `lead_id`,
   `appointments_lead_id_idx`, `max_leads_per_month` — while the init
   migration created `leadId`, `appointments_leadId_idx` and
   `maxLeadsPerMonth`. All three statements carry `IF EXISTS`, so all three
   matched nothing and silently did nothing. `appointments_leadId_fkey`
   survived, and `DROP TABLE "leads"` two statements later failed with
   PostgreSQL `2BP01`.
2. It rebuilt the `AuditAction` enum from a hard-coded list that was already
   stale, dropping values the application writes today and inventing twenty
   the schema has never had.

Both are repaired by **new** migrations rather than an edit, so no committed
migration's checksum changed:

- `20260604230208_repair_lead_removal_prerequisites` runs one second earlier
  and drops the camelCase leftovers, so the removal migration finds its work
  done and its no-op statements stay no-ops;
- `20260605000000_align_audit_action_enum` restores the enum to exactly the
  set in `schema.prisma`, mapping any row holding a now-absent value to
  `OTHER` rather than dropping the row.

Both are guarded and idempotent, and Prisma applies them out of order without
complaint on a database that already has the later migration recorded —
verified, not assumed.

**If an environment is stuck on the failed migration** (`_prisma_migrations`
holds the row with `finished_at` NULL), `migrate deploy` refuses to continue
until it is resolved:

```bash
prisma migrate resolve --rolled-back 20260604230209_remove_internal_leads
prisma migrate deploy
```

### The retired public lead capture (closed)

Between 2026-05-20 and 2026-06-04 the marketing site carried a site-wide chat
widget that posted to `POST /api/public/leads`, backed by a `website_leads`
table: name, phone, clinic name, preferred time, an LGPD consent flag and
timestamp, and a SHA-256 hash of the caller's IP.

The feature was retired deliberately and on both sides within three minutes.
The frontend went first — `dentalflow-web` `93807fe` at 23:25 removed the
widget, its hooks, its service and its tests — and the backend followed in
`0be00ef` at 23:28, removing the module, the route and the `WebsiteLead`
model. Because the frontend stopped calling before the endpoint disappeared,
there was never a window in which the live site posted to a dead route.

`20260604230209_remove_internal_leads` deliberately left the table standing,
and its header still says so: it was dropping the *internal* CRM tables and
did not want to take captured public leads with them. That left the migration
history building a table `schema.prisma` does not model.

Production was then checked with read-only queries and has **no**
`website_leads` table — a search of `information_schema.tables` and
`pg_tables` for any table containing "lead" returns nothing. With no data
anywhere to preserve, `20260605000001_drop_orphaned_website_leads` removes the
orphan from the chain. It is guarded with `IF EXISTS`, so it is a no-op
wherever the table is already absent.

**There is no longer a drift allow-list.** `scripts/check-migrations.ts`
requires migrations and `schema.prisma` to agree exactly, and additionally
asks PostgreSQL whether any `%lead%` table survived the chain — a check
against the catalog rather than against `schema.prisma`, because this orphan
was missing from `schema.prisma` and from the code for three months while the
migrations kept building it.

---

## 9. Stripe

The backend validates everything; the client is never trusted. Stripe is the
source of truth for billing state and reaches us through webhooks. Webhook
signatures are verified and events are de-duplicated by id.

Local development needs the Stripe CLI to deliver events:

```bash
stripe listen --forward-to http://localhost:3000/api/billing/webhook
```

Put the printed `whsec_...` into `STRIPE_WEBHOOK_SECRET`.

**Stripe is never reached by an automated test.** The integration and e2e
harnesses stub outbound `fetch` precisely so none can. Webhook handling,
signature verification, event de-duplication, plan pricing and the checkout
success URL are covered by unit tests — real coverage of our side of the
contract, and none at all of Stripe's.

So anything touching checkout, the customer portal or a subscription state
change needs the checklist below before release, in Stripe **test mode**.

### Stripe test-mode QA checklist

Fourteen steps. The first two and the last two are the safety rails; skip them
and a "successful" run proves nothing, or worse, touches real money.

**Before you start**

1. **Test credentials only.** `STRIPE_SECRET_KEY` must begin `sk_test_`, the
   publishable key `pk_test_`, and `STRIPE_WEBHOOK_SECRET` must be the one
   `stripe listen` prints — not a dashboard live-mode secret. Confirm each by
   eye before starting the backend. A key beginning `sk_live_` means stop.
2. **Listen in test mode.** `stripe listen --forward-to
   http://localhost:3000/api/billing/webhook`. The CLI prints the mode it is
   in; it must say test. Keep it open — every step below depends on events
   arriving.

**The purchase**

3. **Start a checkout.** `POST /api/billing/checkout-session` for a plan.
   The response carries a `url` on `checkout.stripe.com`.
4. **Complete it** with test card `4242 4242 4242 4242`, any future expiry,
   any CVC.
5. **Check the placeholder was substituted.** The browser must land on the
   success URL with `?session_id=cs_test_…` — a real id, not the literal
   `{CHECKOUT_SESSION_ID}` and not `%7BCHECKOUT_SESSION_ID%7D`. The URL
   construction is unit-tested (`billing-plan-pricing.spec.ts`); this step
   confirms Stripe's half of it.
6. **Check the callback carries that id through.** The frontend route reads it
   from the query string and sends the same `cs_test_…` value on to the
   backend — not a truncated or re-encoded one.

**Reconciliation**

7. **Sync the session.** `POST /api/billing/checkout-session/sync` with that
   id returns 200 and the clinic's subscription.
8. **Confirm the subscription is live.** `GET /api/billing/subscription`
   reports `ACTIVE` or `TRIALING`, the right plan, and the right interval.
9. **Reconcile twice.** Repeat step 7 with the same session id: it must be
   idempotent — no duplicate subscription, no duplicate invoice, no change of
   status.

**The portal**

10. **Open the billing portal.** `POST /api/billing/portal-session` returns a
    `billing.stripe.com` URL that opens and shows the correct plan.
11. **Change and cancel from the portal.** Switch interval or plan, then
    cancel. The app reports the new plan, and then the subscription as
    cancelling at period end with access continuing until that date.

**The webhook**

12. **Confirm the webhook drove it.** The `stripe listen` output shows the
    subscription event, and the local state changed without anyone calling
    sync by hand.
13. **Replay a delivery.** `stripe events resend <event_id>` for an event
    already processed: it must be de-duplicated — same status, same row
    count, no second invoice.

**Before you close the tab**

14. **Prove nothing live was touched, and nothing leaked.**
    - In the Stripe dashboard, switch to **live mode** and confirm no
      customer, subscription, invoice or checkout session was created during
      the run. Everything must exist only in test mode.
    - Grep the backend log for the run: no `sk_`, no `whsec_`, no `rk_`, no
      bearer token, no full card number. The only Stripe identifiers that may
      appear are object ids (`cus_`, `sub_`, `cs_test_`, `evt_`).
    - Check the HTTP responses the frontend received the same way. A secret in
      a 500 body is a secret in a browser's network tab.

Record the result in the PR, including the step-14 outcome. A change to
checkout, the portal or subscription state that has not been through this list
is not ready to merge.

This remains a manual boundary by choice — reaching the live API from CI would
trade a real dependency and real flakiness for coverage of somebody else's
system. It does not block a release; it gates the parts of one that touch
billing.

---

## 10. Runtime

- Never start the backend in an agent terminal to investigate a runtime error.
  Ask the operator for the output of the terminal already running it.
- Build, typecheck, lint and test commands are always allowed.

---

## 11. Working method

1. Read the code before changing it.
2. Avoid duplication — look for the existing abstraction.
3. Write a plan.
4. Get approval before implementing.

---

## 12. Product workspace and documentation

The frontend is the sibling repository `../dentalflow-web`; inspect its services
and types before changing API contracts. The canonical product documentation is
[../dentalflow-web/docs/README.md](../dentalflow-web/docs/README.md), including
requirements, current architecture, integration reference and release risks.
Update relevant RF/RN/RNF and contract documentation with behavior changes.
Do not duplicate backend rules in frontend code or add personal filesystem paths.
Local private notes are optional context, never implementation authority.
Historical validation statements in this file must be reverified for each release.
