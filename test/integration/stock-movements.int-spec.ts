import { Prisma } from '@prisma/client';

import { StockService } from '../../src/modules/stock/stock.service';
import {
  createIntegrationHarness,
  IntegrationHarness,
} from '../support/integration-harness';
import {
  createClinic,
  createPlan,
  createStockCategory,
  createStockProduct,
  createUser,
  subscribeClinic,
} from '../support/factories';

/**
 * STOCK MOVEMENTS AGAINST REAL POSTGRESQL
 *
 * A stock movement writes the movement row and adjusts the product quantity;
 * those two must agree, and the quantity must never go negative. Both
 * properties are about what the database does under concurrency, so a mocked
 * client cannot demonstrate either.
 *
 * The service already uses a conditional `updateMany` for this
 * (`WHERE currentQuantity >= quantity`). These tests confirm that guard holds
 * when several movements genuinely race — the same shape of proof used for the
 * notification quota, applied to inventory.
 */

const CLINIC = 'clinic-stock';
const OWNER = 'owner-stock';
const CATEGORY = 'category-stock';
const PRODUCT = 'product-stock';

describe('Stock movements (real database)', () => {
  let h: IntegrationHarness;
  let service: StockService;

  beforeAll(async () => {
    h = await createIntegrationHarness();
    service = h.app.get(StockService);
  }, 60_000);

  afterAll(async () => {
    await h.close();
  });

  async function seed(startingQuantity: number) {
    await h.truncate();
    await createClinic(h.prisma, { id: CLINIC, name: 'Clínica Estoque' });
    await createPlan(h.prisma, { id: 'plan-stock', slug: 'stock-plan' });
    await subscribeClinic(h.prisma, CLINIC, { planId: 'plan-stock' });
    await createUser(h.prisma, { id: OWNER, clinicId: CLINIC, role: 'OWNER' });
    await createStockCategory(h.prisma, { id: CATEGORY, clinicId: CLINIC });
    await createStockProduct(h.prisma, {
      id: PRODUCT,
      clinicId: CLINIC,
      categoryId: CATEGORY,
      currentQuantity: startingQuantity,
      minQuantity: 5,
    });
  }

  const move = (
    type: 'IN' | 'OUT' | 'LOSS' | 'ADJUSTMENT',
    quantity: number,
    extra: Record<string, unknown> = {},
  ) =>
    service.createMovement(CLINIC, OWNER, {
      productId: PRODUCT,
      type,
      quantity,
      ...extra,
    } as never);

  async function quantity(): Promise<number> {
    const product = await h.prisma.stockProduct.findUniqueOrThrow({
      where: { id: PRODUCT },
    });
    return Number(product.currentQuantity);
  }

  // ── Sequential arithmetic ──────────────────────────────────────────────────

  describe('sequential movements', () => {
    it('adds stock on an inbound movement', async () => {
      await seed(100);

      await move('IN', 25);

      expect(await quantity()).toBe(125);
    });

    it('removes stock on an outbound movement', async () => {
      await seed(100);

      await move('OUT', 30);

      expect(await quantity()).toBe(70);
    });

    it('removes stock on a loss', async () => {
      await seed(100);

      await move('LOSS', 10);

      expect(await quantity()).toBe(90);
    });

    it('records the before and after quantities on the movement row', async () => {
      await seed(100);

      await move('OUT', 40);

      const movement = await h.prisma.stockMovement.findFirstOrThrow({
        where: { productId: PRODUCT },
      });
      expect(Number(movement.previousQuantity)).toBe(100);
      expect(Number(movement.newQuantity)).toBe(60);
    });

    it('keeps the movement history and the product quantity in agreement', async () => {
      await seed(100);

      await move('IN', 50);
      await move('OUT', 20);
      await move('LOSS', 5);

      const movements = await h.prisma.stockMovement.findMany({
        where: { productId: PRODUCT },
        orderBy: { createdAt: 'asc' },
      });
      const net = movements.reduce((total, m) => {
        const q = Number(m.quantity);
        return m.type === 'IN' ? total + q : total - q;
      }, 100);

      expect(await quantity()).toBe(net);
      expect(await quantity()).toBe(125);
    });

    it('supports fractional quantities without drift', async () => {
      // currentQuantity is Decimal(10,3) — three decimal places must survive.
      await seed(10);

      await move('OUT', 0.125);
      await move('OUT', 0.125);

      const product = await h.prisma.stockProduct.findUniqueOrThrow({
        where: { id: PRODUCT },
      });
      expect(product.currentQuantity).toBeInstanceOf(Prisma.Decimal);
      // Decimal, not float: 10 - 0.125 - 0.125 is exact, with no 9.749999…
      expect(product.currentQuantity.equals(new Prisma.Decimal('9.75'))).toBe(
        true,
      );
    });
  });

  // ── The negative-stock guard ───────────────────────────────────────────────

  describe('negative stock', () => {
    it('refuses an outbound movement larger than the stock on hand', async () => {
      await seed(10);

      await expect(move('OUT', 11)).rejects.toThrow(/negativo/);
      expect(await quantity()).toBe(10);
    });

    it('allows an outbound movement that empties the stock exactly', async () => {
      await seed(10);

      await move('OUT', 10);

      expect(await quantity()).toBe(0);
    });

    it('writes no movement row when the guard rejects', async () => {
      await seed(10);

      await move('OUT', 11).catch(() => undefined);

      await expect(
        h.prisma.stockMovement.count({ where: { productId: PRODUCT } }),
      ).resolves.toBe(0);
    });

    it('refuses a movement against a deactivated product', async () => {
      await seed(100);
      await h.prisma.stockProduct.update({
        where: { id: PRODUCT },
        data: { isActive: false },
      });

      await expect(move('IN', 10)).rejects.toThrow();
      expect(await quantity()).toBe(100);
    });
  });

  // ── Concurrency ────────────────────────────────────────────────────────────

  describe('concurrent movements', () => {
    it('never lets concurrent outbound movements drive the stock negative', async () => {
      // Ten simultaneous withdrawals of 10 against 50 in stock: at most five
      // can succeed. A read-then-write would let all ten through and leave
      // the quantity at -50.
      await seed(50);

      const results = await Promise.allSettled(
        Array.from({ length: 10 }, () => move('OUT', 10)),
      );

      const succeeded = results.filter((r) => r.status === 'fulfilled').length;
      const finalQuantity = await quantity();

      expect(finalQuantity).toBeGreaterThanOrEqual(0);
      expect(finalQuantity).toBe(50 - succeeded * 10);
      expect(succeeded).toBeLessThanOrEqual(5);
    });

    it('keeps the movement count consistent with the quantity after a burst', async () => {
      await seed(100);

      await Promise.allSettled([
        ...Array.from({ length: 5 }, () => move('IN', 10)),
        ...Array.from({ length: 5 }, () => move('OUT', 10)),
      ]);

      const movements = await h.prisma.stockMovement.findMany({
        where: { productId: PRODUCT },
      });
      const net = movements.reduce((total, m) => {
        const q = Number(m.quantity);
        return m.type === 'IN' ? total + q : total - q;
      }, 100);

      expect(await quantity()).toBe(net);
    });

    it('loses no inbound movement when several arrive together', async () => {
      // Increments are unconditional, so all of them must land.
      await seed(0);

      await Promise.all(Array.from({ length: 10 }, () => move('IN', 3)));

      expect(await quantity()).toBe(30);
    });
  });

  // ── Transactionality ───────────────────────────────────────────────────────

  describe('transactionality', () => {
    it('writes the movement and the new quantity together', async () => {
      await seed(100);

      await move('OUT', 25);

      const movements = await h.prisma.stockMovement.count({
        where: { productId: PRODUCT },
      });
      expect(movements).toBe(1);
      expect(await quantity()).toBe(75);
    });

    it('leaves nothing behind when the product belongs to another clinic', async () => {
      await seed(100);
      await createClinic(h.prisma, { id: 'clinic-other', name: 'Outra' });
      await createUser(h.prisma, {
        id: 'owner-other',
        clinicId: 'clinic-other',
        role: 'OWNER',
      });

      await expect(
        service.createMovement('clinic-other', 'owner-other', {
          productId: PRODUCT,
          type: 'OUT',
          quantity: 5,
        } as never),
      ).rejects.toThrow();

      expect(await quantity()).toBe(100);
      await expect(
        h.prisma.stockMovement.count({ where: { productId: PRODUCT } }),
      ).resolves.toBe(0);
    });
  });

  // ── Derived status ─────────────────────────────────────────────────────────

  describe('stock status', () => {
    it('reports a product at or below its minimum as low', async () => {
      await seed(5);

      const product = await service.getProduct(CLINIC, PRODUCT);
      expect(product.status).toBe('LOW');
    });

    it('reports an empty product as EMPTY', async () => {
      await seed(0);

      const product = await service.getProduct(CLINIC, PRODUCT);
      expect(product.status).toBe('EMPTY');
    });

    it('reports a well-stocked product as ACTIVE', async () => {
      await seed(100);

      const product = await service.getProduct(CLINIC, PRODUCT);
      expect(product.status).toBe('ACTIVE');
    });

    it('recomputes the status after a movement empties the product', async () => {
      await seed(10);

      await move('OUT', 10);

      const product = await service.getProduct(CLINIC, PRODUCT);
      expect(product.status).toBe('EMPTY');
    });

    it('reports a deactivated product as INACTIVE regardless of quantity', async () => {
      await seed(100);
      await h.prisma.stockProduct.update({
        where: { id: PRODUCT },
        data: { isActive: false },
      });

      const product = await service.getProduct(CLINIC, PRODUCT);
      expect(product.status).toBe('INACTIVE');
    });
  });
});
