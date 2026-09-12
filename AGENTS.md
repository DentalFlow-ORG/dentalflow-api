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

| Purpose                | Command                  |
| ---------------------- | ------------------------ |
| Type check             | `bun run typecheck`      |
| Lint (**validation**)  | `bun run lint:check`     |
| Lint (mutating)        | `bun run lint`           |
| Unit + integration     | `bun run test`           |
| Coverage               | `bun run test:cov`       |
| E2E (needs a database) | `bun run test:e2e`       |
| Dead-code analysis     | `bun run deadcode`       |
| Prisma schema check    | `bun run prisma:validate` |
| Build                  | `bun run build`          |
| Everything             | `bun run verify`         |

`bun run lint` runs `eslint --fix` and **rewrites files**. Never use it as a
validation step or in CI. Use `lint:check`.

`lint:check` currently reports a large pre-existing backlog, most of it
Prettier formatting, because the repository has only ever been linted with
`--fix`. It is therefore not yet part of `verify`. Do not add to that backlog:
run Prettier over the files you touch.

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

- `*.spec.ts` beside the code — unit tests, run by `bun run test`.
- `*.http.spec.ts` — the same runner, but booting the real application over
  HTTP through `test/support/http-harness.ts`. Real routing, real pipes, real
  guards, real filters, with `PrismaService` replaced by an in-memory mock.
- `test/*.e2e-spec.ts` — `bun run test:e2e`, against a real database.

### The harness

`createHarness()` gives you `prisma` (the mock), `tokenFor(user)` (a genuinely
signed JWT for a registered user), `signRaw()` for malformed/expired tokens,
`__calls()` to inspect the queries a handler issued, and `__reset()`.

`test/support/tenant-store.ts` adds a store that actually evaluates the `where`
clause, so cross-tenant behaviour can be observed rather than inferred.

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

`bun run test:e2e` does need PostgreSQL. **Never point it at the development
`DATABASE_URL`**, which is a shared Supabase instance. Provide a disposable
database:

```bash
docker run --rm -d -p 5433:5432 \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=dentalflow_test \
  --name dentalflow-test-db postgres:16

export DATABASE_URL="postgresql://postgres:test@localhost:5433/dentalflow_test"
bunx prisma migrate deploy
bun run test:e2e
```

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

## 12. Local session context (optional)

Moved here from `README.md`, where it did not belong: these notes live on one
maintainer's machine, so skip this section silently if the path does not exist.

At the start of a session, read:

```
D:\Obsidian\Cérebro Claude\Cérebro Claude\01 - Projects\Active Projects\DentalFlow\
  DentalFlow — Next Step.md
  DentalFlow — Roadmap Master.md
  DentalFlow — Database Schema.md
  DentalFlow — Backend Analysis.md
  DentalFlow — Architecture Patterns.md
```

Then say what to implement this session and ask whether to start inspecting
the code.
