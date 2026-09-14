import { Prisma, StockMovementType } from '@prisma/client';

import { StockAbnormalConsumptionService } from './stock-abnormal-consumption.service';

/**
 * Loss anomalies, and how the findings are ranked.
 *
 * The consumption-spike branch has a suite. The loss branch — the one that
 * surfaces a product being written off more than it used to — did not, and it
 * is the half a clinic would use to notice theft, spoilage or a broken
 * fridge.
 *
 * It has two modes, and the distinction matters. With no prior losses on
 * record the severity comes from *how many* write-offs appeared; with a
 * history it comes from the rate against that history. A product that has
 * always lost a little should not be flagged for losing a little more.
 */

const CLINIC = 'clinic-1';

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 3600 * 1000);
}

function movement(overrides: {
  productId?: string;
  type: StockMovementType;
  quantity: number;
  daysAgo: number;
}) {
  return {
    productId: overrides.productId ?? 'product-1',
    type: overrides.type,
    quantity: new Prisma.Decimal(overrides.quantity),
    createdAt: daysAgo(overrides.daysAgo),
  };
}

function product(overrides: Record<string, unknown> = {}) {
  return {
    id: 'product-1',
    name: 'Anestésico',
    currentQuantity: new Prisma.Decimal(100),
    minQuantity: new Prisma.Decimal(10),
    unit: 'CX',
    category: { name: 'Anestésicos' },
    ...overrides,
  };
}

const loss = (quantity: number, ago: number, productId?: string) =>
  movement({
    productId,
    type: StockMovementType.LOSS,
    quantity,
    daysAgo: ago,
  });

describe('StockAbnormalConsumptionService — losses', () => {
  let prisma: {
    stockMovement: { findMany: jest.Mock };
    stockProduct: { findMany: jest.Mock };
  };
  let service: StockAbnormalConsumptionService;

  beforeEach(() => {
    prisma = {
      stockMovement: { findMany: jest.fn().mockResolvedValue([]) },
      stockProduct: { findMany: jest.fn().mockResolvedValue([product()]) },
    };
    service = new StockAbnormalConsumptionService(prisma as never);
  });

  /** Runs the detector over a set of movements and returns the findings. */
  async function detect(movements: unknown[], products = [product()]) {
    prisma.stockMovement.findMany.mockResolvedValue(movements);
    prisma.stockProduct.findMany.mockResolvedValue(products);
    const result = await service.getAbnormalConsumption(CLINIC, {} as never);
    return result;
  }

  // ── A product that has never been written off before ───────────────────────

  describe('a first-time loss', () => {
    it('is reported even with a single write-off', async () => {
      const result = await detect([loss(5, 3)]);

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        anomalyType: 'LOSS_SPIKE',
        severity: 'LOW',
        recentQuantity: 5,
        baselineQuantity: 0,
        movementCount: 1,
      });
    });

    it('carries no percentage, because there is nothing to compare against', async () => {
      const result = await detect([loss(5, 3)]);

      // A percentage against a zero baseline is either infinity or a lie.
      expect(result.items[0].changePercent).toBeNull();
    });

    it('escalates to medium at two write-offs', async () => {
      const result = await detect([loss(2, 3), loss(3, 5)]);

      expect(result.items[0]).toMatchObject({
        severity: 'MEDIUM',
        movementCount: 2,
      });
    });

    it('escalates to high at three', async () => {
      const result = await detect([loss(1, 2), loss(1, 4), loss(1, 6)]);

      expect(result.items[0]).toMatchObject({
        severity: 'HIGH',
        movementCount: 3,
      });
    });

    it('says how many there were, in the plural only when it should', async () => {
      const single = await detect([loss(5, 3)]);
      expect(single.items[0].reason).toContain('1 registro de perda');

      const many = await detect([loss(5, 3), loss(5, 4)]);
      expect(many.items[0].reason).toContain('2 registros de perda');
    });
  });

  // ── A product with a loss history ──────────────────────────────────────────

  describe('a loss against a history', () => {
    /** One historical write-off per week across the baseline window. */
    const history = [loss(10, 20), loss(10, 30), loss(10, 40), loss(10, 50)];

    it('is not reported when the rate is steady', async () => {
      // 40 lost over 46 historical days is about 0.87/day; 10 over 14 recent
      // days is about 0.71 — lower, so nothing to flag.
      const result = await detect([...history, loss(10, 3)]);

      expect(result.items).toHaveLength(0);
    });

    it('is reported once the recent rate doubles', async () => {
      // Baseline 40 over 46 days is 0.87/day. 30 over 14 days is 2.14/day —
      // about 2.5x, inside the medium band.
      const result = await detect([...history, loss(30, 3)]);

      expect(result.items[0]).toMatchObject({
        anomalyType: 'LOSS_SPIKE',
        severity: 'MEDIUM',
      });
    });

    it('is not reported just below the doubling threshold', async () => {
      // 20 over 14 days is 1.43/day, about 1.6x the baseline: elevated, but
      // not enough to put in front of a clinic as an anomaly.
      const result = await detect([...history, loss(20, 3)]);

      expect(result.items).toHaveLength(0);
    });

    it('is high severity once it triples', async () => {
      const result = await detect([...history, loss(60, 3)]);

      expect(result.items[0].severity).toBe('HIGH');
    });

    it('reports the increase as a percentage over the baseline', async () => {
      const result = await detect([...history, loss(30, 3)]);

      expect(result.items[0]).toMatchObject({
        recentQuantity: 30,
        baselineQuantity: 40,
      });
      expect(result.items[0].changePercent).toBeGreaterThan(0);
    });

    it('is silent when there is no recent loss at all', async () => {
      const result = await detect(history);

      expect(result.items).toHaveLength(0);
    });
  });

  // ── Ranking ────────────────────────────────────────────────────────────────

  describe('the ranking', () => {
    it('puts the most severe findings first', async () => {
      const products = [
        product({ id: 'p-low', name: 'Baixo' }),
        product({ id: 'p-high', name: 'Alto' }),
      ];
      const result = await detect(
        [
          loss(1, 3, 'p-low'),
          loss(1, 2, 'p-high'),
          loss(1, 4, 'p-high'),
          loss(1, 6, 'p-high'),
        ],
        products,
      );

      expect(result.items.map((i) => i.severity)).toEqual(['HIGH', 'LOW']);
    });

    it('counts the findings by severity', async () => {
      const products = [
        product({ id: 'p-low', name: 'Baixo' }),
        product({ id: 'p-high', name: 'Alto' }),
      ];
      const result = await detect(
        [
          loss(1, 3, 'p-low'),
          loss(1, 2, 'p-high'),
          loss(1, 4, 'p-high'),
          loss(1, 6, 'p-high'),
        ],
        products,
      );

      expect(result.summary).toMatchObject({
        highSeverity: 1,
        lowSeverity: 1,
      });
    });
  });

  // ── What each finding carries ──────────────────────────────────────────────

  describe('each finding', () => {
    it('names the product and its category', async () => {
      const result = await detect([loss(5, 3)]);

      expect(result.items[0]).toMatchObject({
        productName: 'Anestésico',
        categoryName: 'Anestésicos',
        unit: 'CX',
        currentQuantity: 100,
        minQuantity: 10,
      });
    });

    it('copes with a product that has no category', async () => {
      const result = await detect([loss(5, 3)], [product({ category: null })]);

      expect(result.items[0].categoryName).toBeNull();
    });

    it('suggests what to do about it', async () => {
      const result = await detect([loss(5, 3)]);

      // The finding is for a receptionist, not an analyst; it has to say what
      // the next step is.
      expect(result.items[0].suggestedAction).toContain('Investigue');
    });
  });
});
