import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, StockMovementType } from '@prisma/client';

import { StockService } from './stock.service';

const CLINIC_ID = 'clinic-1';
const USER_ID = 'user-1';
const PRODUCT_ID = 'product-1';
const CATEGORY_ID = 'category-1';

const txMock = {
  stockProduct: {
    findFirst: jest.fn(),
    updateMany: jest.fn(),
  },
  stockMovement: {
    create: jest.fn(),
  },
};

const prismaMock = {
  $transaction: jest.fn((callback: (tx: typeof txMock) => unknown) =>
    callback(txMock),
  ),
  stockCategory: {
    findFirst: jest.fn(),
    delete: jest.fn(),
  },
  stockProduct: {
    findFirst: jest.fn(),
    count: jest.fn(),
    update: jest.fn(),
  },
};

function product(
  quantity: number,
  overrides: { clinicId?: string; isActive?: boolean } = {},
) {
  return {
    id: PRODUCT_ID,
    clinicId: overrides.clinicId ?? CLINIC_ID,
    isActive: overrides.isActive ?? true,
    currentQuantity: new Prisma.Decimal(quantity),
  };
}

function movement(overrides: {
  type: StockMovementType;
  quantity: Prisma.Decimal;
  previousQuantity: Prisma.Decimal;
  newQuantity: Prisma.Decimal;
}) {
  return {
    id: 'movement-1',
    clinicId: CLINIC_ID,
    productId: PRODUCT_ID,
    type: overrides.type,
    quantity: overrides.quantity,
    previousQuantity: overrides.previousQuantity,
    newQuantity: overrides.newQuantity,
  };
}

describe('StockService', () => {
  let service: StockService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new StockService(prismaMock as never);
  });

  describe('createMovement', () => {
    it('creates an IN movement after atomically increasing stock', async () => {
      txMock.stockProduct.findFirst
        .mockResolvedValueOnce(product(10))
        .mockResolvedValueOnce({ currentQuantity: new Prisma.Decimal(15) });
      txMock.stockProduct.updateMany.mockResolvedValue({ count: 1 });
      txMock.stockMovement.create.mockResolvedValue(
        movement({
          type: StockMovementType.IN,
          quantity: new Prisma.Decimal(5),
          previousQuantity: new Prisma.Decimal(10),
          newQuantity: new Prisma.Decimal(15),
        }),
      );

      const result = await service.createMovement(CLINIC_ID, USER_ID, {
        productId: PRODUCT_ID,
        type: StockMovementType.IN,
        quantity: 5,
      });

      expect(txMock.stockProduct.updateMany).toHaveBeenCalledWith({
        where: { id: PRODUCT_ID, clinicId: CLINIC_ID, isActive: true },
        data: { currentQuantity: { increment: new Prisma.Decimal(5) } },
      });
      expect(txMock.stockMovement.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            clinicId: CLINIC_ID,
            productId: PRODUCT_ID,
            previousQuantity: new Prisma.Decimal(10),
            newQuantity: new Prisma.Decimal(15),
          }),
        }),
      );
      expect(result).toMatchObject({
        quantity: 5,
        previousQuantity: 10,
        newQuantity: 15,
      });
    });

    it('creates an OUT movement after atomically decreasing stock', async () => {
      txMock.stockProduct.findFirst
        .mockResolvedValueOnce(product(10))
        .mockResolvedValueOnce({ currentQuantity: new Prisma.Decimal(7) });
      txMock.stockProduct.updateMany.mockResolvedValue({ count: 1 });
      txMock.stockMovement.create.mockResolvedValue(
        movement({
          type: StockMovementType.OUT,
          quantity: new Prisma.Decimal(3),
          previousQuantity: new Prisma.Decimal(10),
          newQuantity: new Prisma.Decimal(7),
        }),
      );

      const result = await service.createMovement(CLINIC_ID, USER_ID, {
        productId: PRODUCT_ID,
        type: StockMovementType.OUT,
        quantity: 3,
      });

      expect(txMock.stockProduct.updateMany).toHaveBeenCalledWith({
        where: {
          id: PRODUCT_ID,
          clinicId: CLINIC_ID,
          isActive: true,
          currentQuantity: { gte: new Prisma.Decimal(3) },
        },
        data: { currentQuantity: { decrement: new Prisma.Decimal(3) } },
      });
      expect(result).toMatchObject({
        quantity: 3,
        previousQuantity: 10,
        newQuantity: 7,
      });
    });

    it('blocks OUT movement when quantity is insufficient before updating stock', async () => {
      txMock.stockProduct.findFirst.mockResolvedValueOnce(product(2));

      await expect(
        service.createMovement(CLINIC_ID, USER_ID, {
          productId: PRODUCT_ID,
          type: StockMovementType.OUT,
          quantity: 5,
        }),
      ).rejects.toThrow(BadRequestException);

      expect(txMock.stockProduct.updateMany).not.toHaveBeenCalled();
      expect(txMock.stockMovement.create).not.toHaveBeenCalled();
    });

    it('does not create movement when the conditional stock update fails', async () => {
      txMock.stockProduct.findFirst.mockResolvedValueOnce(product(10));
      txMock.stockProduct.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        service.createMovement(CLINIC_ID, USER_ID, {
          productId: PRODUCT_ID,
          type: StockMovementType.OUT,
          quantity: 3,
        }),
      ).rejects.toThrow(BadRequestException);

      expect(txMock.stockMovement.create).not.toHaveBeenCalled();
    });

    it('filters stock product lookup and update by clinicId', async () => {
      txMock.stockProduct.findFirst
        .mockResolvedValueOnce(product(4))
        .mockResolvedValueOnce({ currentQuantity: new Prisma.Decimal(5) });
      txMock.stockProduct.updateMany.mockResolvedValue({ count: 1 });
      txMock.stockMovement.create.mockResolvedValue(
        movement({
          type: StockMovementType.IN,
          quantity: new Prisma.Decimal(1),
          previousQuantity: new Prisma.Decimal(4),
          newQuantity: new Prisma.Decimal(5),
        }),
      );

      await service.createMovement(CLINIC_ID, USER_ID, {
        productId: PRODUCT_ID,
        type: StockMovementType.IN,
        quantity: 1,
      });

      expect(txMock.stockProduct.findFirst).toHaveBeenNthCalledWith(1, {
        where: { id: PRODUCT_ID, clinicId: CLINIC_ID },
      });
      expect(txMock.stockProduct.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ clinicId: CLINIC_ID }),
        }),
      );
    });

    it('throws NotFoundException and does not create movement for another clinic product', async () => {
      txMock.stockProduct.findFirst.mockResolvedValueOnce(null);

      await expect(
        service.createMovement(CLINIC_ID, USER_ID, {
          productId: PRODUCT_ID,
          type: StockMovementType.IN,
          quantity: 1,
        }),
      ).rejects.toThrow(NotFoundException);

      expect(txMock.stockProduct.updateMany).not.toHaveBeenCalled();
      expect(txMock.stockMovement.create).not.toHaveBeenCalled();
    });

    it.each([0, -1])(
      'rejects %s quantity for non-adjustment movements',
      async (quantity) => {
        await expect(
          service.createMovement(CLINIC_ID, USER_ID, {
            productId: PRODUCT_ID,
            type: StockMovementType.OUT,
            quantity,
          }),
        ).rejects.toThrow(BadRequestException);

        expect(txMock.stockProduct.findFirst).not.toHaveBeenCalled();
        expect(txMock.stockMovement.create).not.toHaveBeenCalled();
      },
    );
  });

  describe('deleteCategory', () => {
    beforeEach(() => {
      prismaMock.stockCategory.findFirst.mockResolvedValue({
        id: CATEGORY_ID,
        clinicId: CLINIC_ID,
      });
      prismaMock.stockProduct.count.mockResolvedValue(0);
      prismaMock.stockCategory.delete.mockResolvedValue({ id: CATEGORY_ID });
    });

    it('throws ConflictException when the category has linked products', async () => {
      prismaMock.stockProduct.count.mockResolvedValue(2);

      await expect(
        service.deleteCategory(CLINIC_ID, CATEGORY_ID),
      ).rejects.toThrow(ConflictException);
      expect(prismaMock.stockCategory.delete).not.toHaveBeenCalled();
    });

    it('hard-deletes the category when it has no products', async () => {
      await service.deleteCategory(CLINIC_ID, CATEGORY_ID);

      expect(prismaMock.stockCategory.delete).toHaveBeenCalledWith({
        where: { id: CATEGORY_ID },
      });
    });

    it('throws NotFoundException for a category belonging to a different clinic', async () => {
      prismaMock.stockCategory.findFirst.mockResolvedValue(null);

      await expect(
        service.deleteCategory(CLINIC_ID, CATEGORY_ID),
      ).rejects.toThrow(NotFoundException);
      expect(prismaMock.stockCategory.delete).not.toHaveBeenCalled();
    });
  });

  describe('deactivateProduct', () => {
    beforeEach(() => {
      prismaMock.stockProduct.findFirst.mockResolvedValue({
        id: PRODUCT_ID,
        clinicId: CLINIC_ID,
        isActive: true,
        category: { id: CATEGORY_ID },
      });
      prismaMock.stockProduct.update.mockResolvedValue({
        id: PRODUCT_ID,
        isActive: false,
      });
    });

    it('sets isActive: false on the product', async () => {
      await service.deactivateProduct(CLINIC_ID, PRODUCT_ID);

      expect(prismaMock.stockProduct.update).toHaveBeenCalledWith({
        where: { id: PRODUCT_ID },
        data: { isActive: false },
      });
    });

    it('throws NotFoundException for a product belonging to a different clinic', async () => {
      prismaMock.stockProduct.findFirst.mockResolvedValue(null);

      await expect(
        service.deactivateProduct(CLINIC_ID, PRODUCT_ID),
      ).rejects.toThrow(NotFoundException);
      expect(prismaMock.stockProduct.update).not.toHaveBeenCalled();
    });
  });
});
