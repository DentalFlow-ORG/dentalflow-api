# CLAUDE.md

**[AGENTS.md](./AGENTS.md) is the authoritative instruction file for this
repository.** Read it first and follow it. This file exists only so Claude
Code finds the instructions by its conventional name; everything substantive
lives there, and it is kept in one place deliberately — two copies of a rule
become two different rules.

## The short version

- **Bun only.** Never `npm`, `pnpm` or `yarn`.
- **`bun run lint` rewrites files** (`eslint --fix`). Use `bun run lint:check`
  to validate. `bun run verify` runs the full gate.
- **Controllers carry no logic.** Resolve scope via `AccessPolicyService`,
  then delegate to a service.
- **Every route declares a policy** — `@Roles(...)`, `@AnyAuthenticated()` or
  `@Public()` — and is listed in `test/support/route-access-matrix.ts`. Adding
  or changing an endpoint means updating that table.
- **Every endpoint taking an entity id** must decide, explicitly, what happens
  when the id belongs to another clinic. Scope the query, answer 404.
- **Every confirmed bug gets a failing regression test first.**
- **Never start the server to debug**; ask for the output of the terminal
  already running it.
- **Never run `test:e2e` or `test:integration` against the development
  `DATABASE_URL`** — it is a shared Supabase instance holding real clinic
  data. Start the throwaway one with `bun run test:db:up`; both suites refuse
  to run against anything else. See AGENTS.md §8.
- **`prisma db push` is not proof that the migration history works.** It
  reads `schema.prisma` and never opens `prisma/migrations`. The gate is
  `bun run test:migrations`, which builds a throwaway database from the real
  migrations — run it after touching anything under `prisma/`.
- **Prefer a new corrective migration to editing a committed one**, whose
  checksum other environments have already recorded. See AGENTS.md §8.
- **Stripe has no automated coverage against the live API.** Changes to
  checkout, the portal or subscription state need the test-mode checklist in
  AGENTS.md §9 before merge.
- **Do not commit or push unless asked.**
- **Never add a `Co-Authored-By` trailer or a "Generated with…" footer** to a
  commit or pull request. This project does not use them.

Everything else — the guard chain, the role and tenancy model, the permanent
testing rules, the test harness, Stripe and migration policy — is in
[AGENTS.md](./AGENTS.md).
