import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma, StockMovementType } from '@prisma/client';

import { StockService } from './stock.service';

/**
 * The stock catalogue: categories, products, and the status the rest of the
 * product derives from them.
 *
 * `createMovement` and its concurrency guard already have suites, one of them
 * against real PostgreSQL. What had none is everything around them — the
 * category a product cannot orphan, the two edits the service refuses outright,
 * the list filter that runs half in SQL and half in memory, and `computeStatus`,
 * which decides on every screen whether a product reads as low, empty or
 * expired.
 *
 * `computeStatus` is the one to read closely. Expiry is a calendar-date
 * comparison against *Brazil's* today, not the server's, and the stored value
 * is UTC midnight. Between 00:00 and 03:00 UTC those are different days, and
 * getting it wrong marks a clinic's stock expired a day early.
 */

const CLINIC = 'clinic-1';
const CATEGORY = 'category-1';
const PRODUCT = 'product-1';

/** 2026-06-15 in Brazil; the clock is frozen so expiry is deterministic. */
const FROZEN_NOW = new Date('2026-06-15T12:00:00.000Z');

function createPrisma() {
  return {
    stockCategory: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    stockProduct: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
    },
    stockMovement: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    $transaction: jest.fn(),
  };
}

function productRow(overrides: Record<string, unknown> = {}) {
  return {
    id: PRODUCT,
    clinicId: CLINIC,
    categoryId: CATEGORY,
    name: 'Anestésico',
    description: null,
    unit: 'CX',
    currentQuantity: new Prisma.Decimal(10),
    minQuantity: new Prisma.Decimal(2),
    purchasePrice: null,
    supplier: null,
    expiresAt: null,
    notes: null,
    isActive: true,
    category: { id: CATEGORY, name: 'Anestésicos' },
    ...overrides,
  };
}

describe('StockService — catalogue', () => {
  let prisma: ReturnType<typeof createPrisma>;
  let service: StockService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(FROZEN_NOW);
    prisma = createPrisma();
    prisma.stockCategory.findFirst.mockResolvedValue({
      id: CATEGORY,
      clinicId: CLINIC,
    });
    prisma.stockProduct.findFirst.mockResolvedValue(productRow());
    prisma.stockProduct.update.mockResolvedValue(productRow());
    prisma.stockProduct.create.mockResolvedValue(productRow());
    // listMovements uses the array form of $transaction; createMovement uses
    // the callback form. Support both so neither test has to know which.
    prisma.$transaction.mockImplementation((arg: unknown) =>
      Array.isArray(arg)
        ? Promise.all(arg)
        : (arg as (tx: unknown) => unknown)(prisma),
    );
    service = new StockService(prisma as never);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // ── Categories ─────────────────────────────────────────────────────────────

  describe('categories', () => {
    it('lists them with the number of products in each', async () => {
      prisma.stockCategory.findMany.mockResolvedValue([
        {
          id: CATEGORY,
          name: 'Anestésicos',
          _count: { products: 3 },
        },
      ]);

      const result = await service.listCategories(CLINIC);

      expect(result).toEqual([
        { id: CATEGORY, name: 'Anestésicos', productCount: 3 },
      ]);
      // `_count` is Prisma's shape, not the API's, and must not leak.
      expect(result[0]).not.toHaveProperty('_count');
    });

    it('lists only the caller’s clinic, alphabetically', async () => {
      await service.listCategories(CLINIC);

      expect(prisma.stockCategory.findMany.mock.calls[0][0]).toMatchObject({
        where: { clinicId: CLINIC },
        orderBy: { name: 'asc' },
      });
    });

    it('creates one inside the caller’s clinic', async () => {
      await service.createCategory(CLINIC, {
        name: 'Descartáveis',
        color: '#10B981',
      } as never);

      expect(prisma.stockCategory.create.mock.calls[0][0].data).toEqual({
        clinicId: CLINIC,
        name: 'Descartáveis',
        color: '#10B981',
      });
    });

    it('updates only the fields the caller sent', async () => {
      await service.updateCategory(CLINIC, CATEGORY, {
        color: '#EF4444',
      } as never);

      expect(prisma.stockCategory.update.mock.calls[0][0].data).toEqual({
        color: '#EF4444',
      });
    });

    it('reports a category from another clinic as not found', async () => {
      prisma.stockCategory.findFirst.mockResolvedValue(null);

      await expect(
        service.updateCategory(CLINIC, 'foreign', { name: 'x' } as never),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.stockCategory.update).not.toHaveBeenCalled();
    });

    it('scopes the category lookup to the clinic', async () => {
      await service.updateCategory(CLINIC, CATEGORY, { name: 'x' } as never);

      expect(prisma.stockCategory.findFirst.mock.calls[0][0].where).toEqual({
        id: CATEGORY,
        clinicId: CLINIC,
      });
    });

    it('deletes an empty category', async () => {
      prisma.stockProduct.count.mockResolvedValue(0);

      await service.deleteCategory(CLINIC, CATEGORY);

      expect(prisma.stockCategory.delete).toHaveBeenCalledWith({
        where: { id: CATEGORY },
      });
    });
  });

  // ── Product status ─────────────────────────────────────────────────────────

  describe('the status a product reports', () => {
    async function statusOf(overrides: Record<string, unknown>) {
      prisma.stockProduct.findFirst.mockResolvedValue(productRow(overrides));
      const result = await service.getProduct(CLINIC, PRODUCT);
      return result.status;
    }

    it('is INACTIVE for a deactivated product, whatever its quantity', async () => {
      await expect(
        statusOf({ isActive: false, currentQuantity: new Prisma.Decimal(0) }),
      ).resolves.toBe('INACTIVE');
    });

    it('is EMPTY at zero', async () => {
      await expect(
        statusOf({ currentQuantity: new Prisma.Decimal(0) }),
      ).resolves.toBe('EMPTY');
    });

    it('is LOW at or below the minimum', async () => {
      await expect(
        statusOf({
          currentQuantity: new Prisma.Decimal(2),
          minQuantity: new Prisma.Decimal(2),
        }),
      ).resolves.toBe('LOW');
    });

    it('is ACTIVE above the minimum', async () => {
      await expect(
        statusOf({
          currentQuantity: new Prisma.Decimal(3),
          minQuantity: new Prisma.Decimal(2),
        }),
      ).resolves.toBe('ACTIVE');
    });

    it('is ACTIVE when no minimum is configured', async () => {
      await expect(
        statusOf({
          currentQuantity: new Prisma.Decimal(1),
          minQuantity: new Prisma.Decimal(0),
        }),
      ).resolves.toBe('ACTIVE');
    });

    it('is EXPIRED once the date has passed', async () => {
      await expect(
        statusOf({ expiresAt: new Date('2026-06-14T00:00:00.000Z') }),
      ).resolves.toBe('EXPIRED');
    });

    it('is not yet EXPIRED on the day itself', async () => {
      // Expiring "today" still leaves the clinic a day to use the item.
      await expect(
        statusOf({ expiresAt: new Date('2026-06-15T00:00:00.000Z') }),
      ).resolves.toBe('EXPIRING');
    });

    it('is EXPIRING inside the warning window', async () => {
      await expect(
        statusOf({ expiresAt: new Date('2026-07-10T00:00:00.000Z') }),
      ).resolves.toBe('EXPIRING');
    });

    it('is not EXPIRING beyond the warning window', async () => {
      await expect(
        statusOf({ expiresAt: new Date('2026-12-31T00:00:00.000Z') }),
      ).resolves.toBe('ACTIVE');
    });

    it('lets expiry outrank a low quantity', async () => {
      await expect(
        statusOf({
          expiresAt: new Date('2026-01-01T00:00:00.000Z'),
          currentQuantity: new Prisma.Decimal(1),
          minQuantity: new Prisma.Decimal(5),
        }),
      ).resolves.toBe('EXPIRED');
    });

    it('exposes the decimal quantities as numbers', async () => {
      prisma.stockProduct.findFirst.mockResolvedValue(
        productRow({
          currentQuantity: new Prisma.Decimal('10.50'),
          minQuantity: new Prisma.Decimal('2.25'),
        }),
      );

      const result = await service.getProduct(CLINIC, PRODUCT);

      expect(result.currentQuantity).toBe(10.5);
      expect(result.minQuantity).toBe(2.25);
    });
  });

  /**
   * The Brazil-vs-UTC boundary, isolated. At 01:00 UTC on the 16th it is still
   * the 15th in Brazil, so an item expiring on the 15th is not expired yet.
   */
  describe('expiry across the Brazil midnight boundary', () => {
    it('does not expire an item a day early', async () => {
      jest.setSystemTime(new Date('2026-06-16T01:00:00.000Z'));
      prisma.stockProduct.findFirst.mockResolvedValue(
        productRow({ expiresAt: new Date('2026-06-15T00:00:00.000Z') }),
      );

      const result = await service.getProduct(CLINIC, PRODUCT);

      expect(result.status).toBe('EXPIRING');
    });

    it('expires it once Brazil has passed midnight too', async () => {
      jest.setSystemTime(new Date('2026-06-16T04:00:00.000Z'));
      prisma.stockProduct.findFirst.mockResolvedValue(
        productRow({ expiresAt: new Date('2026-06-15T00:00:00.000Z') }),
      );

      const result = await service.getProduct(CLINIC, PRODUCT);

      expect(result.status).toBe('EXPIRED');
    });
  });

  // ── Summary ────────────────────────────────────────────────────────────────

  describe('the dashboard summary', () => {
    it('counts each status and values the stock it can price', async () => {
      prisma.stockProduct.findMany.mockResolvedValue([
        {
          isActive: true,
          currentQuantity: new Prisma.Decimal(0),
          minQuantity: new Prisma.Decimal(2),
          expiresAt: null,
          purchasePrice: 500,
        },
        {
          isActive: true,
          currentQuantity: new Prisma.Decimal(2),
          minQuantity: new Prisma.Decimal(2),
          expiresAt: null,
          purchasePrice: 100,
        },
        {
          isActive: true,
          currentQuantity: new Prisma.Decimal(10),
          minQuantity: new Prisma.Decimal(1),
          expiresAt: new Date('2026-06-20T00:00:00.000Z'),
          purchasePrice: null,
        },
        {
          isActive: true,
          currentQuantity: new Prisma.Decimal(4),
          minQuantity: new Prisma.Decimal(1),
          expiresAt: new Date('2026-01-01T00:00:00.000Z'),
          purchasePrice: 250,
        },
      ]);
      prisma.stockProduct.count.mockResolvedValue(7);
      prisma.stockCategory.count.mockResolvedValue(3);

      const summary = await service.getSummary(CLINIC);

      expect(summary).toEqual({
        totalActive: 4,
        emptyStock: 1,
        lowStock: 1,
        expiring: 1,
        expired: 1,
        inactive: 7,
        // 0*500 + 2*100 + (unpriced) + 4*250
        estimatedValue: 1200,
        totalCategories: 3,
      });
    });

    it('counts inactive products separately from the active ones', async () => {
      await service.getSummary(CLINIC);

      expect(prisma.stockProduct.count.mock.calls[0][0].where).toEqual({
        clinicId: CLINIC,
        isActive: false,
      });
      expect(prisma.stockProduct.findMany.mock.calls[0][0].where).toEqual({
        clinicId: CLINIC,
        isActive: true,
      });
    });

    it('reports an empty clinic as zeroes rather than failing', async () => {
      const summary = await service.getSummary(CLINIC);

      expect(summary).toMatchObject({ totalActive: 0, estimatedValue: 0 });
    });
  });

  // ── Listing ────────────────────────────────────────────────────────────────

  describe('listing products', () => {
    it('filters by category and name inside the clinic', async () => {
      await service.listProducts(CLINIC, {
        categoryId: CATEGORY,
        search: 'anest',
      } as never);

      expect(prisma.stockProduct.findMany.mock.calls[0][0].where).toEqual({
        clinicId: CLINIC,
        categoryId: CATEGORY,
        name: { contains: 'anest', mode: 'insensitive' },
      });
    });

    it('asks the database only for inactive products when that is the filter', async () => {
      await service.listProducts(CLINIC, { status: 'INACTIVE' } as never);

      expect(prisma.stockProduct.findMany.mock.calls[0][0].where.isActive).toBe(
        false,
      );
    });

    it('asks only for active ones for every other status filter', async () => {
      await service.listProducts(CLINIC, { status: 'EXPIRED' } as never);

      // The status itself is computed, so it cannot be a SQL predicate; the
      // active flag can be, and pre-filtering it keeps the page honest.
      expect(prisma.stockProduct.findMany.mock.calls[0][0].where.isActive).toBe(
        true,
      );
    });

    it('places no active filter when no status is asked for', async () => {
      await service.listProducts(CLINIC, {} as never);

      expect(
        prisma.stockProduct.findMany.mock.calls[0][0].where,
      ).not.toHaveProperty('isActive');
    });

    it('keeps only the products matching the computed status', async () => {
      prisma.stockProduct.findMany.mockResolvedValue([
        productRow({ id: 'p-1', currentQuantity: new Prisma.Decimal(0) }),
        productRow({ id: 'p-2', currentQuantity: new Prisma.Decimal(50) }),
      ]);

      const result = await service.listProducts(CLINIC, {
        status: 'EMPTY',
      } as never);

      expect(result.data.map((p) => p.id)).toEqual(['p-1']);
      expect(result.total).toBe(1);
    });

    it('reports the total after filtering, not the row count', async () => {
      prisma.stockProduct.findMany.mockResolvedValue([
        productRow({ id: 'p-1', currentQuantity: new Prisma.Decimal(0) }),
        productRow({ id: 'p-2', currentQuantity: new Prisma.Decimal(50) }),
        productRow({ id: 'p-3', currentQuantity: new Prisma.Decimal(50) }),
      ]);

      const result = await service.listProducts(CLINIC, {
        status: 'ACTIVE',
      } as never);

      // A total of 3 here would make the client page through rows it will
      // never be shown.
      expect(result.total).toBe(2);
    });

    it('pages the filtered list', async () => {
      prisma.stockProduct.findMany.mockResolvedValue(
        Array.from({ length: 5 }, (_, i) => productRow({ id: `p-${i}` })),
      );

      const result = await service.listProducts(CLINIC, {
        page: 2,
        limit: 2,
      } as never);

      expect(result.data.map((p) => p.id)).toEqual(['p-2', 'p-3']);
      expect(result).toMatchObject({ total: 5, page: 2, limit: 2 });
    });

    it('defaults to the first page of twenty', async () => {
      const result = await service.listProducts(CLINIC, {} as never);

      expect(result).toMatchObject({ page: 1, limit: 20 });
    });
  });

  // ── Creating and editing ───────────────────────────────────────────────────

  describe('creating a product', () => {
    it('defaults the unit and the active flag', async () => {
      await service.createProduct(CLINIC, {
        categoryId: CATEGORY,
        name: 'Gaze',
      } as never);

      expect(prisma.stockProduct.create.mock.calls[0][0].data).toMatchObject({
        clinicId: CLINIC,
        unit: 'unidade',
        isActive: true,
      });
    });

    it('leaves the quantities to the column defaults when unspecified', async () => {
      await service.createProduct(CLINIC, {
        categoryId: CATEGORY,
        name: 'Gaze',
      } as never);

      const data = prisma.stockProduct.create.mock.calls[0][0].data;
      expect(data).not.toHaveProperty('currentQuantity');
      expect(data).not.toHaveProperty('minQuantity');
    });

    it('stores the quantities as decimals when given', async () => {
      await service.createProduct(CLINIC, {
        categoryId: CATEGORY,
        name: 'Gaze',
        currentQuantity: 10.5,
        minQuantity: 2,
      } as never);

      const data = prisma.stockProduct.create.mock.calls[0][0].data;
      expect(data.currentQuantity).toBeInstanceOf(Prisma.Decimal);
      expect(String(data.currentQuantity)).toBe('10.5');
    });

    it('stores the expiry as UTC midnight of the calendar date', async () => {
      await service.createProduct(CLINIC, {
        categoryId: CATEGORY,
        name: 'Gaze',
        expiresAt: '2027-03-01',
      } as never);

      const data = prisma.stockProduct.create.mock.calls[0][0].data;
      expect((data.expiresAt as Date).toISOString()).toBe(
        '2027-03-01T00:00:00.000Z',
      );
    });

    it('refuses a category belonging to another clinic', async () => {
      prisma.stockCategory.findFirst.mockResolvedValue(null);

      await expect(
        service.createProduct(CLINIC, {
          categoryId: 'foreign',
          name: 'Gaze',
        } as never),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.stockProduct.create).not.toHaveBeenCalled();
    });
  });

  describe('editing a product', () => {
    it('refuses to set the quantity directly', async () => {
      // Quantity is an audited value: it moves only through a movement, which
      // records who changed it and by how much.
      await expect(
        service.updateProduct(CLINIC, PRODUCT, {
          currentQuantity: 99,
        } as never),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.stockProduct.update).not.toHaveBeenCalled();
    });

    it('refuses even a quantity of zero', async () => {
      await expect(
        service.updateProduct(CLINIC, PRODUCT, {
          currentQuantity: 0,
        } as never),
      ).rejects.toThrow(BadRequestException);
    });

    it('clears optional fields on null and resets the minimum to zero', async () => {
      await service.updateProduct(CLINIC, PRODUCT, {
        supplier: null,
        description: null,
        notes: null,
        purchasePrice: null,
        expiresAt: null,
        minQuantity: null,
      } as never);

      const data = prisma.stockProduct.update.mock.calls[0][0].data as Record<
        string,
        unknown
      >;
      expect(data).toMatchObject({
        supplier: null,
        description: null,
        notes: null,
        purchasePrice: null,
        expiresAt: null,
      });
      // minQuantity is non-nullable: null means "no minimum", stored as 0.
      expect(String(data.minQuantity)).toBe('0');
    });

    it('refuses to edit an inactive product', async () => {
      prisma.stockProduct.findFirst.mockResolvedValue(
        productRow({ isActive: false }),
      );

      await expect(
        service.updateProduct(CLINIC, PRODUCT, { name: 'Novo' } as never),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.stockProduct.update).not.toHaveBeenCalled();
    });

    it('reports a product from another clinic as not found', async () => {
      prisma.stockProduct.findFirst.mockResolvedValue(null);

      await expect(
        service.updateProduct(CLINIC, 'foreign', { name: 'Novo' } as never),
      ).rejects.toThrow(NotFoundException);
    });

    it('writes only the fields the caller sent', async () => {
      await service.updateProduct(CLINIC, PRODUCT, {
        name: 'Novo nome',
      } as never);

      expect(prisma.stockProduct.update.mock.calls[0][0].data).toEqual({
        name: 'Novo nome',
      });
    });

    it('validates a new category against the clinic before moving the product', async () => {
      prisma.stockCategory.findFirst.mockResolvedValue(null);

      await expect(
        service.updateProduct(CLINIC, PRODUCT, {
          categoryId: 'foreign',
        } as never),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.stockProduct.update).not.toHaveBeenCalled();
    });

    it('clears the expiry when the caller sends null', async () => {
      await service.updateProduct(CLINIC, PRODUCT, {
        expiresAt: null,
      } as never);

      expect(prisma.stockProduct.update.mock.calls[0][0].data).toEqual({
        expiresAt: null,
      });
    });

    it('reactivates a product', async () => {
      await service.reactivateProduct(CLINIC, PRODUCT);

      expect(prisma.stockProduct.update.mock.calls[0][0]).toMatchObject({
        where: { id: PRODUCT },
        data: { isActive: true },
      });
    });

    it('refuses to reactivate a product from another clinic', async () => {
      prisma.stockProduct.findFirst.mockResolvedValue(null);

      await expect(
        service.reactivateProduct(CLINIC, 'foreign'),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.stockProduct.update).not.toHaveBeenCalled();
    });
  });

  // ── Movement payload rules ─────────────────────────────────────────────────

  describe('what a movement payload must say', () => {
    function attempt(dto: Record<string, unknown>) {
      return service.createMovement(CLINIC, 'user-1', dto as never);
    }

    it('requires a final quantity on an adjustment', async () => {
      await expect(
        attempt({ productId: PRODUCT, type: StockMovementType.ADJUSTMENT }),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses a movement amount on an adjustment', async () => {
      // An adjustment says where the count landed; a quantity would leave two
      // contradictory readings of the same event.
      await expect(
        attempt({
          productId: PRODUCT,
          type: StockMovementType.ADJUSTMENT,
          newQuantity: 5,
          quantity: 2,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('requires a quantity on an entry', async () => {
      await expect(
        attempt({ productId: PRODUCT, type: StockMovementType.IN }),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses a quantity of zero', async () => {
      await expect(
        attempt({
          productId: PRODUCT,
          type: StockMovementType.OUT,
          quantity: 0,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses a negative quantity', async () => {
      await expect(
        attempt({
          productId: PRODUCT,
          type: StockMovementType.LOSS,
          quantity: -5,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses a final quantity on anything but an adjustment', async () => {
      await expect(
        attempt({
          productId: PRODUCT,
          type: StockMovementType.IN,
          quantity: 5,
          newQuantity: 20,
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects the payload before touching the database', async () => {
      await expect(
        attempt({ productId: PRODUCT, type: StockMovementType.IN }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  // ── Movement history ───────────────────────────────────────────────────────

  describe('movement history', () => {
    it('filters by product and type inside the clinic', async () => {
      await service.listMovements(CLINIC, {
        productId: PRODUCT,
        type: StockMovementType.OUT,
      } as never);

      expect(
        prisma.stockMovement.findMany.mock.calls[0][0].where,
      ).toMatchObject({
        clinicId: CLINIC,
        productId: PRODUCT,
        type: StockMovementType.OUT,
      });
    });

    it('bounds a date filter on Brazil midnight, not UTC midnight', async () => {
      await service.listMovements(CLINIC, {
        dateFrom: '2026-06-01',
        dateTo: '2026-06-30',
      } as never);

      const where = prisma.stockMovement.findMany.mock.calls[0][0].where as {
        createdAt: { gte: Date; lt: Date };
      };
      // Brazil is UTC-3, so its day starts at 03:00 UTC. Using UTC midnight
      // would pull in three hours of the previous Brazil day at one end and
      // drop three hours of the last one at the other.
      expect(where.createdAt.gte.toISOString()).toBe(
        '2026-06-01T03:00:00.000Z',
      );
      expect(where.createdAt.lt.toISOString()).toBe('2026-07-01T03:00:00.000Z');
    });

    it('places no date predicate when neither bound is given', async () => {
      await service.listMovements(CLINIC, {} as never);

      expect(
        prisma.stockMovement.findMany.mock.calls[0][0].where,
      ).not.toHaveProperty('createdAt');
    });

    it('scopes a product’s history to the clinic that owns it', async () => {
      prisma.stockProduct.findFirst.mockResolvedValue(null);

      await expect(
        service.listProductMovements(CLINIC, 'foreign', {} as never),
      ).rejects.toThrow(NotFoundException);
      expect(prisma.stockMovement.findMany).not.toHaveBeenCalled();
    });

    it('exposes movement decimals as numbers', async () => {
      prisma.stockMovement.findMany.mockResolvedValue([
        {
          id: 'm-1',
          quantity: new Prisma.Decimal('2.50'),
          previousQuantity: new Prisma.Decimal('10.00'),
          newQuantity: new Prisma.Decimal('7.50'),
        },
      ]);

      const result = await service.listMovements(CLINIC, {} as never);

      expect(result.data[0]).toMatchObject({
        quantity: 2.5,
        previousQuantity: 10,
        newQuantity: 7.5,
      });
    });
  });
});
