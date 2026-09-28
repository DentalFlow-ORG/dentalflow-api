import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import {
  MAX_CENTS_AMOUNT,
  MAX_ID_LENGTH,
  MAX_STOCK_QUANTITY,
} from '../../../common/validators/input-validation.decorators';
import { CreateStockProductDto } from './create-stock-product.dto';
import { UpdateStockProductDto } from './update-stock-product.dto';
import { CreateStockMovementDto } from './create-stock-movement.dto';
import { ListStockProductsDto } from './list-stock-products.dto';
import { ListStockMovementsDto } from './list-stock-movements.dto';
import { UpdateStockCategoryDto } from './update-stock-category.dto';

async function validateDto<T extends object>(
  cls: new () => T,
  payload: Record<string, unknown>,
) {
  return validate(plainToInstance(cls, payload));
}

describe('stock DTO validation', () => {
  describe('categoryId safety in CreateStockProductDto', () => {
    it('rejects path-traversal characters in categoryId', async () => {
      const errors = await validateDto(CreateStockProductDto, {
        name: 'Luva descartável',
        categoryId: '../admin',
      });
      expect(errors.some((e) => e.property === 'categoryId')).toBe(true);
    });

    it('rejects categoryId longer than MAX_ID_LENGTH', async () => {
      const errors = await validateDto(CreateStockProductDto, {
        name: 'Luva descartável',
        categoryId: 'a'.repeat(MAX_ID_LENGTH + 1),
      });
      expect(errors.some((e) => e.property === 'categoryId')).toBe(true);
    });

    it('accepts a valid categoryId', async () => {
      const errors = await validateDto(CreateStockProductDto, {
        name: 'Luva descartável',
        categoryId: 'category-1',
      });
      expect(errors.some((e) => e.property === 'categoryId')).toBe(false);
    });
  });

  describe('categoryId safety in UpdateStockProductDto', () => {
    it('rejects path-traversal characters in categoryId', async () => {
      const errors = await validateDto(UpdateStockProductDto, {
        categoryId: '../clinic',
      });
      expect(errors.some((e) => e.property === 'categoryId')).toBe(true);
    });

    it('rejects categoryId longer than MAX_ID_LENGTH', async () => {
      const errors = await validateDto(UpdateStockProductDto, {
        categoryId: 'a'.repeat(MAX_ID_LENGTH + 1),
      });
      expect(errors.some((e) => e.property === 'categoryId')).toBe(true);
    });
  });

  describe('productId safety in CreateStockMovementDto', () => {
    it('rejects path-traversal characters in productId', async () => {
      const errors = await validateDto(CreateStockMovementDto, {
        productId: '../products',
        type: 'IN',
        quantity: 5,
      });
      expect(errors.some((e) => e.property === 'productId')).toBe(true);
    });

    it('rejects productId longer than MAX_ID_LENGTH', async () => {
      const errors = await validateDto(CreateStockMovementDto, {
        productId: 'a'.repeat(MAX_ID_LENGTH + 1),
        type: 'IN',
        quantity: 5,
      });
      expect(errors.some((e) => e.property === 'productId')).toBe(true);
    });
  });

  describe('ListStockProductsDto', () => {
    it('rejects limit above 100', async () => {
      const errors = await validateDto(ListStockProductsDto, { limit: 101 });
      expect(errors.some((e) => e.property === 'limit')).toBe(true);
    });

    it('accepts limit at exactly 100 (boundary)', async () => {
      const errors = await validateDto(ListStockProductsDto, { limit: 100 });
      expect(errors.some((e) => e.property === 'limit')).toBe(false);
    });

    it('rejects unsafe characters in categoryId filter', async () => {
      const errors = await validateDto(ListStockProductsDto, {
        categoryId: 'category/1',
      });
      expect(errors.some((e) => e.property === 'categoryId')).toBe(true);
    });

    it('rejects search longer than 100 characters', async () => {
      const errors = await validateDto(ListStockProductsDto, {
        search: 'a'.repeat(101),
      });
      expect(errors.some((e) => e.property === 'search')).toBe(true);
    });

    it('accepts search at exactly 100 characters (boundary)', async () => {
      const errors = await validateDto(ListStockProductsDto, {
        search: 'a'.repeat(100),
      });
      expect(errors.some((e) => e.property === 'search')).toBe(false);
    });
  });

  describe('ListStockMovementsDto', () => {
    it('rejects limit above 100', async () => {
      const errors = await validateDto(ListStockMovementsDto, { limit: 101 });
      expect(errors.some((e) => e.property === 'limit')).toBe(true);
    });

    it('accepts limit at exactly 100 (boundary)', async () => {
      const errors = await validateDto(ListStockMovementsDto, { limit: 100 });
      expect(errors.some((e) => e.property === 'limit')).toBe(false);
    });

    it('rejects unsafe characters in productId filter', async () => {
      const errors = await validateDto(ListStockMovementsDto, {
        productId: 'product/1',
      });
      expect(errors.some((e) => e.property === 'productId')).toBe(true);
    });

    it('rejects productId filter longer than MAX_ID_LENGTH', async () => {
      const errors = await validateDto(ListStockMovementsDto, {
        productId: 'a'.repeat(MAX_ID_LENGTH + 1),
      });
      expect(errors.some((e) => e.property === 'productId')).toBe(true);
    });
  });

  describe('limits and PATCH clears', () => {
    it.each(['description', 'supplier', 'notes', 'expiresAt'])(
      'clears %s on update with null or a blank string',
      async (field) => {
        const fromNull = plainToInstance(UpdateStockProductDto, {
          [field]: null,
        });
        const fromBlank = plainToInstance(UpdateStockProductDto, {
          [field]: '  ',
        });
        expect(await validate(fromNull)).toEqual([]);
        expect(await validate(fromBlank)).toEqual([]);
        expect(
          (fromNull as unknown as Record<string, unknown>)[field],
        ).toBeNull();
        expect(
          (fromBlank as unknown as Record<string, unknown>)[field],
        ).toBeNull();
      },
    );

    it('accepts null for purchasePrice and minQuantity (clear / reset)', async () => {
      const errors = await validateDto(UpdateStockProductDto, {
        purchasePrice: null,
        minQuantity: null,
      });
      expect(errors).toEqual([]);
    });

    // Regression: `@Type(() => Number)` turned a blank price into 0, storing
    // R$ 0,00 for a price nobody entered. The column is nullable.
    it.each([
      [UpdateStockProductDto, ''],
      [UpdateStockProductDto, '  '],
      [CreateStockProductDto, ''],
    ])(
      '%p maps a blank purchase price %j to null, not 0',
      async (cls, blank) => {
        const instance = plainToInstance(cls, {
          name: 'Luva',
          categoryId: 'category-1',
          purchasePrice: blank,
        });
        expect(await validate(instance)).toEqual([]);
        expect(instance.purchasePrice).toBeNull();
      },
    );

    it('round-trips a numeric purchase price in cents, including a string', async () => {
      const fromNumber = plainToInstance(UpdateStockProductDto, {
        purchasePrice: 1500,
      });
      const fromString = plainToInstance(UpdateStockProductDto, {
        purchasePrice: '1500',
      });
      expect(fromNumber.purchasePrice).toBe(1500);
      expect(fromString.purchasePrice).toBe(1500);
      expect(await validate(fromString)).toEqual([]);
    });

    it('rejects a non-numeric or fractional purchase price', async () => {
      for (const purchasePrice of ['abc', 15.5]) {
        const errors = await validateDto(UpdateStockProductDto, {
          purchasePrice,
        });
        expect(errors.some((e) => e.property === 'purchasePrice')).toBe(true);
      }
    });

    it('refuses a blank unit on update, since the row requires one', async () => {
      const errors = await validateDto(UpdateStockProductDto, { unit: '  ' });
      expect(errors.some((e) => e.property === 'unit')).toBe(true);
    });

    it.each(['name', 'categoryId', 'unit', 'isActive'])(
      'refuses null for %s on update',
      async (field) => {
        const errors = await validateDto(UpdateStockProductDto, {
          [field]: null,
        });
        expect(errors.some((e) => e.property === field)).toBe(true);
      },
    );

    it('caps the purchase price at MAX_CENTS_AMOUNT', async () => {
      const base = { name: 'Luva', categoryId: 'category-1' };
      const ok = await validateDto(CreateStockProductDto, {
        ...base,
        purchasePrice: MAX_CENTS_AMOUNT,
      });
      const over = await validateDto(CreateStockProductDto, {
        ...base,
        purchasePrice: MAX_CENTS_AMOUNT + 1,
      });
      expect(ok.some((e) => e.property === 'purchasePrice')).toBe(false);
      expect(over.some((e) => e.property === 'purchasePrice')).toBe(true);
    });

    it.each([
      [MAX_STOCK_QUANTITY, true],
      [10_000_000, false],
      [1.234, true],
      [1.2345, false],
    ])(
      'checks the movement quantity %p against Decimal(10,3)',
      async (quantity, ok) => {
        const errors = await validateDto(CreateStockMovementDto, {
          productId: 'product-1',
          type: 'IN',
          quantity,
        });
        expect(errors.some((e) => e.property === 'quantity')).toBe(!ok);
      },
    );

    it('refuses a blank category name on update and clears the colour', async () => {
      const blankName = await validateDto(UpdateStockCategoryDto, {
        name: '   ',
      });
      expect(blankName.some((e) => e.property === 'name')).toBe(true);

      const cleared = plainToInstance(UpdateStockCategoryDto, { color: '' });
      expect(await validate(cleared)).toEqual([]);
      expect(cleared.color).toBeNull();
    });
  });
});
