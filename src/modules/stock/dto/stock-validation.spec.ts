import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';

import { MAX_ID_LENGTH } from '../../../common/validators/input-validation.decorators';
import { CreateStockProductDto } from './create-stock-product.dto';
import { UpdateStockProductDto } from './update-stock-product.dto';
import { CreateStockMovementDto } from './create-stock-movement.dto';
import { ListStockProductsDto } from './list-stock-products.dto';
import { ListStockMovementsDto } from './list-stock-movements.dto';

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
});
