import { PrismaMock, recordNotFoundError } from './prisma-mock';

/**
 * A minimal, filtering row store for cross-tenant isolation tests.
 *
 * Asserting that a handler *passes* `clinicId` to Prisma proves the predicate
 * is present. It does not prove the endpoint is safe, because a handler may
 * fetch by primary key and compare afterwards — a pattern that is equally
 * correct but invisible to a predicate check.
 *
 * This store closes that gap by actually evaluating the `where` clause against
 * seeded rows, the way the database would. A test can then seed one row for
 * clinic A and one for clinic B, call the endpoint as clinic A with clinic B's
 * id, and assert on the real outcome rather than on the query shape.
 *
 * It implements the subset of the Prisma filter language the application
 * actually uses for tenant predicates: scalar equality, `equals`/`not`/`in`/
 * `notIn`, null checks, `lt`/`lte`/`gt`/`gte`, `contains`, and `AND`/`OR`/`NOT`
 * composition. Unsupported operators throw rather than silently matching, so a
 * query this store cannot faithfully evaluate fails the test instead of
 * producing a false pass.
 */

type Row = Record<string, unknown>;

const LOGICAL = new Set(['AND', 'OR', 'NOT']);
const SUPPORTED_OPERATORS = new Set([
  'equals',
  'not',
  'in',
  'notIn',
  'lt',
  'lte',
  'gt',
  'gte',
  'contains',
  'startsWith',
  'endsWith',
  'mode',
]);

function matchesCondition(actual: unknown, condition: unknown): boolean {
  if (condition === null) return actual === null || actual === undefined;

  if (
    condition instanceof Date ||
    typeof condition !== 'object' ||
    Array.isArray(condition)
  ) {
    if (condition instanceof Date && actual instanceof Date) {
      return actual.getTime() === condition.getTime();
    }
    return actual === condition;
  }

  const operators = condition as Record<string, unknown>;
  for (const key of Object.keys(operators)) {
    if (!SUPPORTED_OPERATORS.has(key)) {
      throw new Error(
        `tenant-store: unsupported Prisma filter operator "${key}". ` +
          'Extend tenant-store.ts rather than letting the query match by accident.',
      );
    }
  }

  const insensitive = operators.mode === 'insensitive';
  const normalize = (value: unknown) =>
    insensitive && typeof value === 'string' ? value.toLowerCase() : value;

  for (const [operator, expected] of Object.entries(operators)) {
    switch (operator) {
      case 'mode':
        break;
      case 'equals':
        if (!matchesCondition(actual, expected)) return false;
        break;
      case 'not':
        if (matchesCondition(actual, expected)) return false;
        break;
      case 'in':
        if (!(expected as unknown[]).some((v) => matchesCondition(actual, v))) return false;
        break;
      case 'notIn':
        if ((expected as unknown[]).some((v) => matchesCondition(actual, v))) return false;
        break;
      case 'lt':
      case 'lte':
      case 'gt':
      case 'gte': {
        if (actual === null || actual === undefined) return false;
        const a = actual instanceof Date ? actual.getTime() : (actual as number);
        const b = expected instanceof Date ? expected.getTime() : (expected as number);
        if (operator === 'lt' && !(a < b)) return false;
        if (operator === 'lte' && !(a <= b)) return false;
        if (operator === 'gt' && !(a > b)) return false;
        if (operator === 'gte' && !(a >= b)) return false;
        break;
      }
      case 'contains':
        if (
          typeof actual !== 'string' ||
          !String(normalize(actual)).includes(String(normalize(expected)))
        ) {
          return false;
        }
        break;
      case 'startsWith':
        if (
          typeof actual !== 'string' ||
          !String(normalize(actual)).startsWith(String(normalize(expected)))
        ) {
          return false;
        }
        break;
      case 'endsWith':
        if (
          typeof actual !== 'string' ||
          !String(normalize(actual)).endsWith(String(normalize(expected)))
        ) {
          return false;
        }
        break;
    }
  }

  return true;
}

export function matchesWhere(row: Row, where: unknown): boolean {
  if (!where || typeof where !== 'object') return true;

  for (const [field, condition] of Object.entries(where as Row)) {
    if (condition === undefined) continue;

    if (LOGICAL.has(field)) {
      const clauses = (Array.isArray(condition) ? condition : [condition]) as unknown[];
      if (field === 'AND' && !clauses.every((c) => matchesWhere(row, c))) return false;
      if (field === 'OR' && !clauses.some((c) => matchesWhere(row, c))) return false;
      if (field === 'NOT' && clauses.some((c) => matchesWhere(row, c))) return false;
      continue;
    }

    if (!matchesCondition(row[field], condition)) return false;
  }

  return true;
}

/**
 * Replaces the given model's query methods with ones that filter `rows`
 * through `matchesWhere`, so tenant predicates and read-then-verify checks are
 * both exercised against realistic results.
 */
export function seedModel(prisma: PrismaMock, model: string, rows: Row[]): void {
  const find = (args: { where?: unknown } | undefined) =>
    rows.filter((row) => matchesWhere(row, args?.where));

  const first = (args: { where?: unknown } | undefined) => find(args)[0] ?? null;

  prisma[model].findMany.mockImplementation((args: any) => Promise.resolve(find(args)));
  prisma[model].findFirst.mockImplementation((args: any) => Promise.resolve(first(args)));
  prisma[model].findUnique.mockImplementation((args: any) => Promise.resolve(first(args)));
  prisma[model].count.mockImplementation((args: any) => Promise.resolve(find(args).length));

  const orThrow = (args: any) => {
    const row = first(args);
    if (!row) return Promise.reject(recordNotFoundError());
    return Promise.resolve(row);
  };
  prisma[model].findFirstOrThrow.mockImplementation(orThrow);
  prisma[model].findUniqueOrThrow.mockImplementation(orThrow);

  // Prisma's single-row `update`/`delete` reject with P2025 when the where
  // clause matches nothing — the behaviour a tenant-scoped update relies on.
  prisma[model].update.mockImplementation((args: any) => {
    const row = first(args);
    if (!row) return Promise.reject(recordNotFoundError());
    Object.assign(row, args.data ?? {});
    return Promise.resolve(row);
  });
  prisma[model].delete.mockImplementation((args: any) => {
    const row = first(args);
    if (!row) return Promise.reject(recordNotFoundError());
    return Promise.resolve(row);
  });

  prisma[model].updateMany.mockImplementation((args: any) => {
    const matched = find(args);
    for (const row of matched) Object.assign(row, args.data ?? {});
    return Promise.resolve({ count: matched.length });
  });
  prisma[model].deleteMany.mockImplementation((args: any) =>
    Promise.resolve({ count: find(args).length }),
  );
}
