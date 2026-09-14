import { BadRequestException } from '@nestjs/common';
import { Prisma, StockMovementType } from '@prisma/client';

import { StockAbnormalConsumptionService } from './stock-abnormal-consumption.service';

const CLINIC_ID = 'clinic-1';
const OTHER_CLINIC_ID = 'clinic-2';

const prismaMock = {
  stockMovement: { findMany: jest.fn() },
  stockProduct: { findMany: jest.fn() },
};

function daysAgo(n: number): Date {
  return new Date(Date.now() - n * 24 * 3600 * 1000);
}

function makeMovement(overrides: {
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

function makeProduct(overrides: {
  id?: string;
  name?: string;
  currentQuantity?: number;
  minQuantity?: number;
  unit?: string;
  categoryName?: string | null;
}) {
  return {
    id: overrides.id ?? 'product-1',
    name: overrides.name ?? 'Produto Teste',
    currentQuantity: new Prisma.Decimal(overrides.currentQuantity ?? 100),
    minQuantity: new Prisma.Decimal(overrides.minQuantity ?? 10),
    unit: overrides.unit ?? 'unidade',
    category:
      overrides.categoryName != null ? { name: overrides.categoryName } : null,
  };
}

// Default config: recentDays=14, baselineDays=60 → historicalDays=46
// Recent:     daysAgo(1..13)
// Historical: daysAgo(15..59)
const DEFAULT_DTO = {};

describe('StockAbnormalConsumptionService', () => {
  let service: StockAbnormalConsumptionService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new StockAbnormalConsumptionService(prismaMock as never);
  });

  // ── 1. Empty when no movements ───────────────────────────────────────────────

  it('returns empty anomalies and correct summary when no movements exist', async () => {
    prismaMock.stockMovement.findMany.mockResolvedValue([]);
    prismaMock.stockProduct.findMany.mockResolvedValue([makeProduct({})]);

    const result = await service.getAbnormalConsumption(CLINIC_ID, DEFAULT_DTO);

    expect(result.items).toHaveLength(0);
    expect(result.summary.totalAnomalies).toBe(0);
    expect(result.summary.highSeverity).toBe(0);
    expect(result.summary.mediumSeverity).toBe(0);
    expect(result.summary.lowSeverity).toBe(0);
    expect(result.summary.analyzedProducts).toBe(1);
    expect(result.summary.recentDays).toBe(14);
    expect(result.summary.baselineDays).toBe(60);
  });

  // ── 2. CONSUMPTION_SPIKE HIGH (ratio ≥ 3×) ──────────────────────────────────

  it('detects CONSUMPTION_SPIKE HIGH when recent daily rate is ≥ 3× historical', async () => {
    // historicalDays=46: 2 OUT movements totalling 46 units → rate = 1/day
    // recentDays=14: 1 OUT movement of 42 units → rate = 3/day → ratio = 3.0
    prismaMock.stockMovement.findMany.mockResolvedValue([
      makeMovement({ type: StockMovementType.OUT, quantity: 23, daysAgo: 30 }),
      makeMovement({ type: StockMovementType.OUT, quantity: 23, daysAgo: 45 }),
      makeMovement({ type: StockMovementType.OUT, quantity: 42, daysAgo: 7 }),
    ]);
    prismaMock.stockProduct.findMany.mockResolvedValue([makeProduct({})]);

    const result = await service.getAbnormalConsumption(CLINIC_ID, DEFAULT_DTO);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].anomalyType).toBe('CONSUMPTION_SPIKE');
    expect(result.items[0].severity).toBe('HIGH');
    expect(result.items[0].recentQuantity).toBe(42);
    expect(result.items[0].baselineQuantity).toBe(46);
    expect(result.items[0].changePercent).toBeGreaterThanOrEqual(200);
  });

  // ── 3. CONSUMPTION_SPIKE MEDIUM (2× ≤ ratio < 3×) ──────────────────────────

  it('detects CONSUMPTION_SPIKE MEDIUM when recent rate is ≥ 2× but < 3× historical', async () => {
    // historical: 2 movements of 23 each → 46 total / 46 days = 1/day
    // recent: 1 movement of 28 → 28 / 14 = 2/day → ratio = 2.0
    prismaMock.stockMovement.findMany.mockResolvedValue([
      makeMovement({ type: StockMovementType.OUT, quantity: 23, daysAgo: 30 }),
      makeMovement({ type: StockMovementType.OUT, quantity: 23, daysAgo: 45 }),
      makeMovement({ type: StockMovementType.OUT, quantity: 28, daysAgo: 7 }),
    ]);
    prismaMock.stockProduct.findMany.mockResolvedValue([makeProduct({})]);

    const result = await service.getAbnormalConsumption(CLINIC_ID, DEFAULT_DTO);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].anomalyType).toBe('CONSUMPTION_SPIKE');
    expect(result.items[0].severity).toBe('MEDIUM');
  });

  // ── 4. No CONSUMPTION_SPIKE when ratio < 2× ─────────────────────────────────

  it('does not flag CONSUMPTION_SPIKE when recent rate is < 2× historical', async () => {
    // historical: 46 units in 46 days = 1/day
    // recent: 13 units in 14 days ≈ 0.93/day → ratio < 1 → no spike
    prismaMock.stockMovement.findMany.mockResolvedValue([
      makeMovement({ type: StockMovementType.OUT, quantity: 23, daysAgo: 30 }),
      makeMovement({ type: StockMovementType.OUT, quantity: 23, daysAgo: 45 }),
      makeMovement({ type: StockMovementType.OUT, quantity: 13, daysAgo: 7 }),
    ]);
    prismaMock.stockProduct.findMany.mockResolvedValue([makeProduct({})]);

    const result = await service.getAbnormalConsumption(CLINIC_ID, DEFAULT_DTO);

    const spikes = result.items.filter(
      (i) => i.anomalyType === 'CONSUMPTION_SPIKE',
    );
    expect(spikes).toHaveLength(0);
  });

  // ── 5. CONSUMPTION_SPIKE requires ≥ 2 historical movements ──────────────────

  it('skips CONSUMPTION_SPIKE when historicalOUT count < 2 (no reliable baseline)', async () => {
    // Only 1 historical OUT movement → baseline insufficient
    prismaMock.stockMovement.findMany.mockResolvedValue([
      makeMovement({ type: StockMovementType.OUT, quantity: 46, daysAgo: 30 }),
      makeMovement({ type: StockMovementType.OUT, quantity: 42, daysAgo: 7 }),
    ]);
    prismaMock.stockProduct.findMany.mockResolvedValue([makeProduct({})]);

    const result = await service.getAbnormalConsumption(CLINIC_ID, DEFAULT_DTO);

    const spikes = result.items.filter(
      (i) => i.anomalyType === 'CONSUMPTION_SPIKE',
    );
    expect(spikes).toHaveLength(0);
  });

  // ── 6. LOSS_SPIKE HIGH: no history, recentCount ≥ 3 ────────────────────────

  it('detects LOSS_SPIKE HIGH when no historical losses and recentLossCount ≥ 3', async () => {
    prismaMock.stockMovement.findMany.mockResolvedValue([
      makeMovement({ type: StockMovementType.LOSS, quantity: 2, daysAgo: 2 }),
      makeMovement({ type: StockMovementType.LOSS, quantity: 1, daysAgo: 5 }),
      makeMovement({ type: StockMovementType.LOSS, quantity: 3, daysAgo: 10 }),
    ]);
    prismaMock.stockProduct.findMany.mockResolvedValue([makeProduct({})]);

    const result = await service.getAbnormalConsumption(CLINIC_ID, DEFAULT_DTO);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].anomalyType).toBe('LOSS_SPIKE');
    expect(result.items[0].severity).toBe('HIGH');
    expect(result.items[0].movementCount).toBe(3);
    expect(result.items[0].changePercent).toBeNull();
  });

  // ── 7. LOSS_SPIKE MEDIUM: no history, recentCount == 2 ──────────────────────

  it('detects LOSS_SPIKE MEDIUM when no historical losses and recentLossCount == 2', async () => {
    prismaMock.stockMovement.findMany.mockResolvedValue([
      makeMovement({ type: StockMovementType.LOSS, quantity: 1, daysAgo: 3 }),
      makeMovement({ type: StockMovementType.LOSS, quantity: 2, daysAgo: 8 }),
    ]);
    prismaMock.stockProduct.findMany.mockResolvedValue([makeProduct({})]);

    const result = await service.getAbnormalConsumption(CLINIC_ID, DEFAULT_DTO);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].anomalyType).toBe('LOSS_SPIKE');
    expect(result.items[0].severity).toBe('MEDIUM');
  });

  // ── 8. LOSS_SPIKE LOW: no history, recentCount == 1 ─────────────────────────

  it('detects LOSS_SPIKE LOW when no historical losses and recentLossCount == 1', async () => {
    prismaMock.stockMovement.findMany.mockResolvedValue([
      makeMovement({ type: StockMovementType.LOSS, quantity: 1, daysAgo: 5 }),
    ]);
    prismaMock.stockProduct.findMany.mockResolvedValue([makeProduct({})]);

    const result = await service.getAbnormalConsumption(CLINIC_ID, DEFAULT_DTO);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].anomalyType).toBe('LOSS_SPIKE');
    expect(result.items[0].severity).toBe('LOW');
  });

  // ── 9. FREQUENT_ADJUSTMENTS HIGH: recentAdjCount ≥ 3 ───────────────────────

  it('detects FREQUENT_ADJUSTMENTS HIGH when recentAdjCount ≥ 3', async () => {
    prismaMock.stockMovement.findMany.mockResolvedValue([
      makeMovement({
        type: StockMovementType.ADJUSTMENT,
        quantity: 5,
        daysAgo: 2,
      }),
      makeMovement({
        type: StockMovementType.ADJUSTMENT,
        quantity: 3,
        daysAgo: 6,
      }),
      makeMovement({
        type: StockMovementType.ADJUSTMENT,
        quantity: 4,
        daysAgo: 11,
      }),
    ]);
    prismaMock.stockProduct.findMany.mockResolvedValue([makeProduct({})]);

    const result = await service.getAbnormalConsumption(CLINIC_ID, DEFAULT_DTO);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].anomalyType).toBe('FREQUENT_ADJUSTMENTS');
    expect(result.items[0].severity).toBe('HIGH');
    expect(result.items[0].movementCount).toBe(3);
  });

  // ── 10. FREQUENT_ADJUSTMENTS MEDIUM: recentAdjCount == 2 ────────────────────

  it('detects FREQUENT_ADJUSTMENTS MEDIUM when recentAdjCount == 2', async () => {
    prismaMock.stockMovement.findMany.mockResolvedValue([
      makeMovement({
        type: StockMovementType.ADJUSTMENT,
        quantity: 5,
        daysAgo: 3,
      }),
      makeMovement({
        type: StockMovementType.ADJUSTMENT,
        quantity: 3,
        daysAgo: 9,
      }),
    ]);
    prismaMock.stockProduct.findMany.mockResolvedValue([makeProduct({})]);

    const result = await service.getAbnormalConsumption(CLINIC_ID, DEFAULT_DTO);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].anomalyType).toBe('FREQUENT_ADJUSTMENTS');
    expect(result.items[0].severity).toBe('MEDIUM');
  });

  // ── 11. FREQUENT_ADJUSTMENTS not flagged when recentAdjCount < 2 ─────────────

  it('does not flag FREQUENT_ADJUSTMENTS when recentAdjCount < 2', async () => {
    prismaMock.stockMovement.findMany.mockResolvedValue([
      makeMovement({
        type: StockMovementType.ADJUSTMENT,
        quantity: 5,
        daysAgo: 4,
      }),
    ]);
    prismaMock.stockProduct.findMany.mockResolvedValue([makeProduct({})]);

    const result = await service.getAbnormalConsumption(CLINIC_ID, DEFAULT_DTO);

    expect(
      result.items.filter((i) => i.anomalyType === 'FREQUENT_ADJUSTMENTS'),
    ).toHaveLength(0);
  });

  // ── 12. NEW_UNUSUAL_CONSUMPTION ──────────────────────────────────────────────

  it('detects NEW_UNUSUAL_CONSUMPTION when historicalOUT is zero and recentOUT ≥ 1', async () => {
    prismaMock.stockMovement.findMany.mockResolvedValue([
      makeMovement({ type: StockMovementType.OUT, quantity: 5, daysAgo: 3 }),
    ]);
    prismaMock.stockProduct.findMany.mockResolvedValue([
      makeProduct({ currentQuantity: 100 }),
    ]);

    const result = await service.getAbnormalConsumption(CLINIC_ID, DEFAULT_DTO);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].anomalyType).toBe('NEW_UNUSUAL_CONSUMPTION');
    expect(result.items[0].recentQuantity).toBe(5);
    expect(result.items[0].baselineQuantity).toBe(0);
    expect(result.items[0].changePercent).toBeNull();
  });

  // ── 13. Sorting: HIGH before MEDIUM before LOW, then changePercent desc ──────

  it('sorts anomalies HIGH → MEDIUM → LOW, then changePercent desc within tier', async () => {
    // Product A → LOSS_SPIKE LOW (no historical, 1 loss)
    // Product B → CONSUMPTION_SPIKE HIGH (ratio ≥ 3×) with higher changePercent
    // Product C → CONSUMPTION_SPIKE MEDIUM (ratio 2×)
    prismaMock.stockMovement.findMany.mockResolvedValue([
      // Product A: 1 recent LOSS, no history → LOSS_SPIKE LOW
      makeMovement({
        productId: 'product-a',
        type: StockMovementType.LOSS,
        quantity: 1,
        daysAgo: 5,
      }),
      // Product B: historical 2 OUT (46 units total / 46 days = 1/day), recent OUT 3/day → HIGH
      makeMovement({
        productId: 'product-b',
        type: StockMovementType.OUT,
        quantity: 23,
        daysAgo: 30,
      }),
      makeMovement({
        productId: 'product-b',
        type: StockMovementType.OUT,
        quantity: 23,
        daysAgo: 45,
      }),
      makeMovement({
        productId: 'product-b',
        type: StockMovementType.OUT,
        quantity: 42,
        daysAgo: 7,
      }),
      // Product C: historical 2 OUT (46 units), recent 2/day → MEDIUM
      makeMovement({
        productId: 'product-c',
        type: StockMovementType.OUT,
        quantity: 23,
        daysAgo: 30,
      }),
      makeMovement({
        productId: 'product-c',
        type: StockMovementType.OUT,
        quantity: 23,
        daysAgo: 45,
      }),
      makeMovement({
        productId: 'product-c',
        type: StockMovementType.OUT,
        quantity: 28,
        daysAgo: 7,
      }),
    ]);
    prismaMock.stockProduct.findMany.mockResolvedValue([
      makeProduct({ id: 'product-a', name: 'A' }),
      makeProduct({ id: 'product-b', name: 'B' }),
      makeProduct({ id: 'product-c', name: 'C' }),
    ]);

    const result = await service.getAbnormalConsumption(CLINIC_ID, DEFAULT_DTO);

    expect(result.items[0].productId).toBe('product-b'); // HIGH
    expect(result.items[1].productId).toBe('product-c'); // MEDIUM
    expect(result.items[2].productId).toBe('product-a'); // LOW
  });

  // ── 14. Tenant isolation ─────────────────────────────────────────────────────

  it('passes the correct clinicId to both Prisma queries for tenant isolation', async () => {
    prismaMock.stockMovement.findMany.mockResolvedValue([]);
    prismaMock.stockProduct.findMany.mockResolvedValue([]);

    await service.getAbnormalConsumption(OTHER_CLINIC_ID, DEFAULT_DTO);

    expect(prismaMock.stockMovement.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ clinicId: OTHER_CLINIC_ID }),
      }),
    );
    expect(prismaMock.stockProduct.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ clinicId: OTHER_CLINIC_ID }),
      }),
    );
  });

  // ── 15. IN movements are ignored for consumption growth ──────────────────────

  it('ignores IN movements when detecting consumption anomalies', async () => {
    // Many recent IN movements (restocking) should not trigger CONSUMPTION_SPIKE
    prismaMock.stockMovement.findMany.mockResolvedValue([
      makeMovement({ type: StockMovementType.IN, quantity: 100, daysAgo: 1 }),
      makeMovement({ type: StockMovementType.IN, quantity: 100, daysAgo: 3 }),
      makeMovement({ type: StockMovementType.IN, quantity: 100, daysAgo: 7 }),
      // Historical: 2 IN movements (do not count as OUT baseline)
      makeMovement({ type: StockMovementType.IN, quantity: 50, daysAgo: 20 }),
      makeMovement({ type: StockMovementType.IN, quantity: 50, daysAgo: 40 }),
    ]);
    prismaMock.stockProduct.findMany.mockResolvedValue([makeProduct({})]);

    const result = await service.getAbnormalConsumption(CLINIC_ID, DEFAULT_DTO);

    expect(
      result.items.filter((i) => i.anomalyType === 'CONSUMPTION_SPIKE'),
    ).toHaveLength(0);
    expect(
      result.items.filter((i) => i.anomalyType === 'NEW_UNUSUAL_CONSUMPTION'),
    ).toHaveLength(0);
  });

  // ── 16. Inactive products are excluded (Prisma filter) ──────────────────────

  it('queries stockProduct with isActive: true to exclude inactive products', async () => {
    prismaMock.stockMovement.findMany.mockResolvedValue([]);
    prismaMock.stockProduct.findMany.mockResolvedValue([]);

    await service.getAbnormalConsumption(CLINIC_ID, DEFAULT_DTO);

    expect(prismaMock.stockProduct.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isActive: true }),
      }),
    );
  });

  // ── 17. recentDays >= baselineDays throws BadRequestException ─────────────────

  it('throws BadRequestException when recentDays >= baselineDays', async () => {
    await expect(
      service.getAbnormalConsumption(CLINIC_ID, {
        recentDays: 60,
        baselineDays: 60,
      }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      service.getAbnormalConsumption(CLINIC_ID, {
        recentDays: 90,
        baselineDays: 30,
      }),
    ).rejects.toThrow(BadRequestException);
  });
});
