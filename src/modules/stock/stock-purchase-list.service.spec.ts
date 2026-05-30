import { Prisma } from '@prisma/client';
import { StockPurchaseListService } from './stock-purchase-list.service';

const CLINIC_ID = 'clinic-1';
const OTHER_CLINIC_ID = 'clinic-2';

const prismaMock = {
  stockProduct: {
    findMany: jest.fn(),
  },
};

function makeProduct(overrides: {
  id?: string;
  name?: string;
  clinicId?: string;
  isActive?: boolean;
  currentQuantity: number;
  minQuantity: number;
  purchasePrice?: number | null;
  supplier?: string | null;
  unit?: string | null;
  categoryName?: string | null;
}) {
  return {
    id: overrides.id ?? 'product-1',
    name: overrides.name ?? 'Produto Teste',
    clinicId: overrides.clinicId ?? CLINIC_ID,
    isActive: overrides.isActive ?? true,
    currentQuantity: new Prisma.Decimal(overrides.currentQuantity),
    minQuantity: new Prisma.Decimal(overrides.minQuantity),
    purchasePrice: overrides.purchasePrice ?? null,
    supplier: overrides.supplier ?? null,
    unit: overrides.unit ?? 'unidade',
    category:
      overrides.categoryName !== undefined && overrides.categoryName !== null
        ? { id: 'cat-1', name: overrides.categoryName }
        : null,
  };
}

describe('StockPurchaseListService', () => {
  let service: StockPurchaseListService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new StockPurchaseListService(prismaMock as never);
  });

  // ── 1. Empty list when products are above minimum ────────────────────────────

  it('returns empty items and zeroed summary when all products are above minQuantity', async () => {
    prismaMock.stockProduct.findMany.mockResolvedValue([
      makeProduct({ currentQuantity: 15, minQuantity: 10 }),
      makeProduct({ id: 'p2', currentQuantity: 20, minQuantity: 5 }),
    ]);

    const result = await service.getPurchaseList(CLINIC_ID);

    expect(result.items).toHaveLength(0);
    expect(result.summary).toEqual({
      totalItems: 0,
      criticalItems: 0,
      highPriorityItems: 0,
      mediumPriorityItems: 0,
      totalEstimatedCostCents: 0,
    });
  });

  // ── 2. CRITICAL when product is empty ────────────────────────────────────────

  it('classifies a product with currentQuantity = 0 as CRITICAL', async () => {
    prismaMock.stockProduct.findMany.mockResolvedValue([
      makeProduct({ currentQuantity: 0, minQuantity: 10 }),
    ]);

    const result = await service.getPurchaseList(CLINIC_ID);

    expect(result.items).toHaveLength(1);
    expect(result.items[0].priority).toBe('CRITICAL');
    expect(result.items[0].reason).toBe('Produto esgotado.');
  });

  // ── 3. CRITICAL when <= 25% of minQuantity ──────────────────────────────────

  it('classifies a product at exactly 25% of minQuantity as CRITICAL', async () => {
    // ratio = 2.5 / 10 = 0.25
    prismaMock.stockProduct.findMany.mockResolvedValue([
      makeProduct({ currentQuantity: 2.5, minQuantity: 10 }),
    ]);

    const result = await service.getPurchaseList(CLINIC_ID);

    expect(result.items[0].priority).toBe('CRITICAL');
    expect(result.items[0].reason).toBe('Estoque abaixo de 25% do mínimo definido.');
  });

  it('classifies a product below 25% of minQuantity as CRITICAL', async () => {
    // ratio = 2 / 10 = 0.20
    prismaMock.stockProduct.findMany.mockResolvedValue([
      makeProduct({ currentQuantity: 2, minQuantity: 10 }),
    ]);

    const result = await service.getPurchaseList(CLINIC_ID);

    expect(result.items[0].priority).toBe('CRITICAL');
  });

  // ── 4. HIGH when <= 50% of minQuantity ──────────────────────────────────────

  it('classifies a product at exactly 50% of minQuantity as HIGH', async () => {
    // ratio = 5 / 10 = 0.50
    prismaMock.stockProduct.findMany.mockResolvedValue([
      makeProduct({ currentQuantity: 5, minQuantity: 10 }),
    ]);

    const result = await service.getPurchaseList(CLINIC_ID);

    expect(result.items[0].priority).toBe('HIGH');
    expect(result.items[0].reason).toBe('Estoque abaixo de 50% do mínimo definido.');
  });

  it('classifies a product between 25% and 50% of minQuantity as HIGH', async () => {
    // ratio = 4 / 10 = 0.40
    prismaMock.stockProduct.findMany.mockResolvedValue([
      makeProduct({ currentQuantity: 4, minQuantity: 10 }),
    ]);

    const result = await service.getPurchaseList(CLINIC_ID);

    expect(result.items[0].priority).toBe('HIGH');
  });

  // ── 5. MEDIUM when above 50% but <= minQuantity ──────────────────────────────

  it('classifies a product above 50% but below minQuantity as MEDIUM', async () => {
    // ratio = 7 / 10 = 0.70
    prismaMock.stockProduct.findMany.mockResolvedValue([
      makeProduct({ currentQuantity: 7, minQuantity: 10 }),
    ]);

    const result = await service.getPurchaseList(CLINIC_ID);

    expect(result.items[0].priority).toBe('MEDIUM');
    expect(result.items[0].reason).toBe('Estoque abaixo do mínimo definido.');
  });

  // ── 6. Inactive products are excluded ────────────────────────────────────────

  it('queries Prisma with isActive: true so inactive products are excluded', async () => {
    prismaMock.stockProduct.findMany.mockResolvedValue([]);

    await service.getPurchaseList(CLINIC_ID);

    expect(prismaMock.stockProduct.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ isActive: true }),
      }),
    );
  });

  // ── 7. Cross-clinic isolation ────────────────────────────────────────────────

  it('queries Prisma with the caller clinicId to enforce tenant isolation', async () => {
    prismaMock.stockProduct.findMany.mockResolvedValue([]);

    await service.getPurchaseList(OTHER_CLINIC_ID);

    expect(prismaMock.stockProduct.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ clinicId: OTHER_CLINIC_ID }),
      }),
    );
  });

  // ── 8. estimatedCostCents calculated correctly ────────────────────────────────

  it('computes estimatedCostCents as suggestedPurchaseQuantity × purchasePrice', async () => {
    // deficit = 10 - 2 = 8; price = 5000 (R$50.00); estimated = 8 * 5000 = 40000
    prismaMock.stockProduct.findMany.mockResolvedValue([
      makeProduct({ currentQuantity: 2, minQuantity: 10, purchasePrice: 5000 }),
    ]);

    const result = await service.getPurchaseList(CLINIC_ID);

    expect(result.items[0].deficitQuantity).toBe(8);
    expect(result.items[0].suggestedPurchaseQuantity).toBe(8);
    expect(result.items[0].estimatedCostCents).toBe(40000);
  });

  // ── 9. estimatedCostCents null when purchasePrice is null ────────────────────

  it('returns null estimatedCostCents when purchasePrice is null', async () => {
    prismaMock.stockProduct.findMany.mockResolvedValue([
      makeProduct({ currentQuantity: 2, minQuantity: 10, purchasePrice: null }),
    ]);

    const result = await service.getPurchaseList(CLINIC_ID);

    expect(result.items[0].estimatedCostCents).toBeNull();
  });

  // ── 10. Sorting ───────────────────────────────────────────────────────────────

  it('sorts CRITICAL before HIGH before MEDIUM, then by ascending ratio within tier', async () => {
    prismaMock.stockProduct.findMany.mockResolvedValue([
      // MEDIUM: ratio 0.70
      makeProduct({ id: 'p-medium', name: 'C Medium', currentQuantity: 7, minQuantity: 10 }),
      // HIGH: ratio 0.40
      makeProduct({ id: 'p-high', name: 'B High', currentQuantity: 4, minQuantity: 10 }),
      // CRITICAL (empty)
      makeProduct({ id: 'p-crit-empty', name: 'A Critical Empty', currentQuantity: 0, minQuantity: 10 }),
      // CRITICAL: ratio 0.20
      makeProduct({ id: 'p-crit-low', name: 'D Critical Low', currentQuantity: 2, minQuantity: 10 }),
    ]);

    const result = await service.getPurchaseList(CLINIC_ID);

    const ids = result.items.map((i) => i.productId);
    // CRITICAL empty (ratio 0) → CRITICAL low (ratio 0.2) → HIGH (ratio 0.4) → MEDIUM (ratio 0.7)
    expect(ids).toEqual(['p-crit-empty', 'p-crit-low', 'p-high', 'p-medium']);
  });

  it('sorts alphabetically by name (pt-BR) when priority and ratio are equal', async () => {
    prismaMock.stockProduct.findMany.mockResolvedValue([
      makeProduct({ id: 'p2', name: 'Benzocaína', currentQuantity: 0, minQuantity: 10 }),
      makeProduct({ id: 'p1', name: 'Ácido fluorídrico', currentQuantity: 0, minQuantity: 10 }),
    ]);

    const result = await service.getPurchaseList(CLINIC_ID);

    // pt-BR: Á comes before B
    expect(result.items[0].productName).toBe('Ácido fluorídrico');
    expect(result.items[1].productName).toBe('Benzocaína');
  });

  // ── 11. Summary counts ────────────────────────────────────────────────────────

  it('computes summary counts and totalEstimatedCostCents correctly', async () => {
    prismaMock.stockProduct.findMany.mockResolvedValue([
      makeProduct({ id: 'p1', currentQuantity: 0, minQuantity: 10, purchasePrice: 1000 }),    // CRITICAL, cost 10000
      makeProduct({ id: 'p2', currentQuantity: 2, minQuantity: 10, purchasePrice: 500 }),     // CRITICAL, cost 4000
      makeProduct({ id: 'p3', currentQuantity: 4, minQuantity: 10, purchasePrice: 200 }),     // HIGH,     cost 1200
      makeProduct({ id: 'p4', currentQuantity: 7, minQuantity: 10, purchasePrice: null }),    // MEDIUM,   cost null
      makeProduct({ id: 'p5', currentQuantity: 15, minQuantity: 10, purchasePrice: 300 }),    // above min → excluded
    ]);

    const result = await service.getPurchaseList(CLINIC_ID);

    expect(result.summary).toEqual({
      totalItems: 4,
      criticalItems: 2,
      highPriorityItems: 1,
      mediumPriorityItems: 1,
      totalEstimatedCostCents: 10000 + 4000 + 1200, // null treated as 0
    });
  });

  // ── 12. Portuguese reason strings ────────────────────────────────────────────

  it.each([
    { current: 0,   min: 10, expectedReason: 'Produto esgotado.' },
    { current: 2,   min: 10, expectedReason: 'Estoque abaixo de 25% do mínimo definido.' },
    { current: 4,   min: 10, expectedReason: 'Estoque abaixo de 50% do mínimo definido.' },
    { current: 7,   min: 10, expectedReason: 'Estoque abaixo do mínimo definido.' },
  ])('reason for current=$current min=$min is "$expectedReason"', async ({ current, min, expectedReason }) => {
    prismaMock.stockProduct.findMany.mockResolvedValue([
      makeProduct({ currentQuantity: current, minQuantity: min }),
    ]);

    const result = await service.getPurchaseList(CLINIC_ID);

    expect(result.items[0].reason).toBe(expectedReason);
  });
});
