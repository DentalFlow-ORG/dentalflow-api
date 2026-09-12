import { Prisma } from '@prisma/client';

/**
 * In-memory stand-in for PrismaService used by the HTTP application harness.
 *
 * It is intentionally *not* a behavioural database emulator: it exists so the
 * real Nest application (routing, pipes, guards, filters, controllers and
 * services) can be exercised over HTTP without touching infrastructure.
 * Tests assert on the Prisma calls the application makes and on the HTTP
 * responses produced from the rows the mock is told to return.
 *
 * Method results default by name so a service that is not the subject of a
 * given test does not explode on an undefined result:
 *   findMany / groupBy / findRaw → []
 *   count                        → 0
 *   findUnique / findFirst       → null
 *   aggregate                    → { _sum: {}, _count: 0, _avg: {}, ... }
 *   everything else              → {}
 */
export type PrismaMock = Record<string, any> & {
  __reset(): void;
};

function defaultFor(method: string): unknown {
  if (method.startsWith('findMany') || method === 'groupBy') return [];
  if (method.startsWith('count')) return 0;
  if (method === 'findUnique' || method === 'findFirst') return null;
  if (method === 'aggregate') {
    return { _sum: {}, _avg: {}, _min: {}, _max: {}, _count: 0 };
  }
  if (method === 'createMany' || method === 'updateMany' || method === 'deleteMany') {
    return { count: 0 };
  }
  return {};
}

/**
 * Real Prisma rejects with P2025 when an `…OrThrow` query matches nothing.
 * Defaulting these to `null` would let a service dereference a missing row and
 * surface a 500 that production would never produce, so the mock reproduces the
 * genuine failure — which also exercises the P2025 → 404 mapping in
 * GlobalExceptionFilter.
 */
export function recordNotFoundError(): Error {
  const error = new Prisma.PrismaClientKnownRequestError('No record was found', {
    code: 'P2025',
    clientVersion: 'test',
  });
  return error;
}

function createModelMock(): Record<string, jest.Mock> {
  const model: Record<string, jest.Mock> = {};
  return new Proxy(model, {
    get(target, prop: string) {
      if (typeof prop !== 'string') return (target as any)[prop];
      if (!(prop in target)) {
        target[prop] = prop.endsWith('OrThrow')
          ? jest.fn().mockRejectedValue(recordNotFoundError())
          : jest.fn().mockResolvedValue(defaultFor(prop));
      }
      return target[prop];
    },
    has: () => true,
  });
}

export function createPrismaMock(): PrismaMock {
  const models = new Map<string, Record<string, jest.Mock>>();

  const root: Record<string, any> = {
    $connect: jest.fn().mockResolvedValue(undefined),
    $disconnect: jest.fn().mockResolvedValue(undefined),
    $queryRaw: jest.fn().mockResolvedValue([]),
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    $executeRaw: jest.fn().mockResolvedValue(0),
    $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    onModuleInit: jest.fn().mockResolvedValue(undefined),
    onModuleDestroy: jest.fn().mockResolvedValue(undefined),
  };

  // $transaction must actually run the callback so transactional flows are
  // exercised rather than skipped.
  root.$transaction = jest.fn(async (arg: unknown) => {
    if (typeof arg === 'function') {
      return await (arg as (tx: unknown) => unknown)(proxy);
    }
    if (Array.isArray(arg)) return await Promise.all(arg);
    return arg;
  });

  root.__reset = () => {
    models.clear();
    for (const key of Object.keys(root)) {
      const value = root[key];
      if (typeof value === 'function' && 'mockClear' in value) {
        (value as jest.Mock).mockClear();
      }
    }
  };

  const proxy: PrismaMock = new Proxy(root, {
    get(target, prop: string | symbol) {
      if (typeof prop !== 'string') return (target as any)[prop];
      if (prop in target) return target[prop];
      if (prop.startsWith('$') || prop === 'then') return undefined;
      if (!models.has(prop)) models.set(prop, createModelMock());
      return models.get(prop);
    },
    has: () => true,
  }) as PrismaMock;

  return proxy;
}
