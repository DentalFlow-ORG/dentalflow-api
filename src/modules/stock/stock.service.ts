import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateStockCategoryDto } from './dto/create-stock-category.dto';
import { UpdateStockCategoryDto } from './dto/update-stock-category.dto';
import { CreateStockProductDto } from './dto/create-stock-product.dto';
import { UpdateStockProductDto } from './dto/update-stock-product.dto';
import {
  ListStockProductsDto,
  StockProductStatus,
} from './dto/list-stock-products.dto';

const EXPIRY_WARNING_DAYS = 30;

@Injectable()
export class StockService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Categories ──────────────────────────────────────────────────

  async listCategories(clinicId: string) {
    const categories = await this.prisma.stockCategory.findMany({
      where: { clinicId },
      include: { _count: { select: { products: true } } },
      orderBy: { name: 'asc' },
    });

    return categories.map(({ _count, ...rest }) => ({
      ...rest,
      productCount: _count.products,
    }));
  }

  async createCategory(clinicId: string, dto: CreateStockCategoryDto) {
    return this.prisma.stockCategory.create({
      data: {
        clinicId,
        name: dto.name,
        color: dto.color,
      },
    });
  }

  async updateCategory(
    clinicId: string,
    categoryId: string,
    dto: UpdateStockCategoryDto,
  ) {
    await this.assertCategory(clinicId, categoryId);

    return this.prisma.stockCategory.update({
      where: { id: categoryId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.color !== undefined ? { color: dto.color } : {}),
      },
    });
  }

  async deleteCategory(clinicId: string, categoryId: string) {
    await this.assertCategory(clinicId, categoryId);

    const productCount = await this.prisma.stockProduct.count({
      where: { clinicId, categoryId },
    });

    if (productCount > 0) {
      throw new ConflictException(
        'Esta categoria possui produtos vinculados e não pode ser removida.',
      );
    }

    await this.prisma.stockCategory.delete({ where: { id: categoryId } });
  }

  // ── Summary ─────────────────────────────────────────────────────

  async getSummary(clinicId: string) {
    const [activeProducts, inactive, totalCategories] = await Promise.all([
      this.prisma.stockProduct.findMany({
        where: { clinicId, isActive: true },
        select: {
          isActive: true,
          currentQuantity: true,
          minQuantity: true,
          expiresAt: true,
          purchasePrice: true,
        },
      }),
      this.prisma.stockProduct.count({ where: { clinicId, isActive: false } }),
      this.prisma.stockCategory.count({ where: { clinicId } }),
    ]);

    let lowStock = 0;
    let emptyStock = 0;
    let expiring = 0;
    let expired = 0;
    let estimatedValue = 0;

    for (const product of activeProducts) {
      const status = this.computeStatus(product);
      if (status === 'LOW') lowStock++;
      else if (status === 'EMPTY') emptyStock++;
      else if (status === 'EXPIRING') expiring++;
      else if (status === 'EXPIRED') expired++;

      if (product.purchasePrice !== null) {
        estimatedValue += Number(product.currentQuantity) * product.purchasePrice;
      }
    }

    return {
      totalActive: activeProducts.length,
      lowStock,
      emptyStock,
      expiring,
      expired,
      inactive,
      estimatedValue,
      totalCategories,
    };
  }

  // ── Products ────────────────────────────────────────────────────

  async listProducts(clinicId: string, query: ListStockProductsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.StockProductWhereInput = {
      clinicId,
      ...(query.categoryId ? { categoryId: query.categoryId } : {}),
      ...(query.search
        ? { name: { contains: query.search, mode: 'insensitive' } }
        : {}),
      // Pre-filter isActive at DB level when status is unambiguous
      ...(query.status === 'INACTIVE'
        ? { isActive: false }
        : query.status
          ? { isActive: true }
          : {}),
    };

    const raw = await this.prisma.stockProduct.findMany({
      where,
      include: { category: true },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
    });

    const withStatus = raw
      .map((p) => this.serializeProduct(p))
      .filter((p) => (query.status ? p.status === query.status : true));

    const total = withStatus.length;
    const data = withStatus.slice((page - 1) * limit, page * limit);

    return { data, total, page, limit };
  }

  async getProduct(clinicId: string, productId: string) {
    const product = await this.assertProduct(clinicId, productId);
    return this.serializeProduct(product);
  }

  async createProduct(clinicId: string, dto: CreateStockProductDto) {
    await this.assertCategory(clinicId, dto.categoryId);

    const product = await this.prisma.stockProduct.create({
      data: {
        clinicId,
        categoryId: dto.categoryId,
        name: dto.name,
        description: dto.description,
        unit: dto.unit ?? 'unidade',
        ...(dto.currentQuantity !== undefined
          ? { currentQuantity: new Prisma.Decimal(dto.currentQuantity) }
          : {}),
        ...(dto.minQuantity !== undefined
          ? { minQuantity: new Prisma.Decimal(dto.minQuantity) }
          : {}),
        purchasePrice: dto.purchasePrice,
        supplier: dto.supplier,
        expiresAt: dto.expiresAt ? this.parseDate(dto.expiresAt) : undefined,
        notes: dto.notes,
        isActive: dto.isActive ?? true,
      },
      include: { category: true },
    });

    return this.serializeProduct(product);
  }

  async updateProduct(
    clinicId: string,
    productId: string,
    dto: UpdateStockProductDto,
  ) {
    await this.assertProduct(clinicId, productId);

    if (dto.categoryId) {
      await this.assertCategory(clinicId, dto.categoryId);
    }

    const product = await this.prisma.stockProduct.update({
      where: { id: productId },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.categoryId !== undefined ? { categoryId: dto.categoryId } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.unit !== undefined ? { unit: dto.unit } : {}),
        ...(dto.currentQuantity !== undefined
          ? { currentQuantity: new Prisma.Decimal(dto.currentQuantity) }
          : {}),
        ...(dto.minQuantity !== undefined
          ? { minQuantity: new Prisma.Decimal(dto.minQuantity) }
          : {}),
        ...(dto.purchasePrice !== undefined ? { purchasePrice: dto.purchasePrice } : {}),
        ...(dto.supplier !== undefined ? { supplier: dto.supplier } : {}),
        ...(dto.expiresAt !== undefined
          ? { expiresAt: dto.expiresAt ? this.parseDate(dto.expiresAt) : null }
          : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      },
      include: { category: true },
    });

    return this.serializeProduct(product);
  }

  async deactivateProduct(clinicId: string, productId: string) {
    await this.assertProduct(clinicId, productId);

    await this.prisma.stockProduct.update({
      where: { id: productId },
      data: { isActive: false },
    });
  }

  // ── Private helpers ──────────────────────────────────────────────

  private async assertCategory(clinicId: string, categoryId: string) {
    const category = await this.prisma.stockCategory.findFirst({
      where: { id: categoryId, clinicId },
    });

    if (!category) {
      throw new NotFoundException('Categoria de estoque não encontrada.');
    }

    return category;
  }

  private async assertProduct(clinicId: string, productId: string) {
    const product = await this.prisma.stockProduct.findFirst({
      where: { id: productId, clinicId },
      include: { category: true },
    });

    if (!product) {
      throw new NotFoundException('Produto não encontrado.');
    }

    return product;
  }

  private computeStatus(product: {
    isActive: boolean;
    currentQuantity: Prisma.Decimal;
    minQuantity: Prisma.Decimal;
    expiresAt: Date | null;
  }): StockProductStatus {
    if (!product.isActive) return 'INACTIVE';

    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    if (product.expiresAt) {
      const expires = new Date(product.expiresAt);
      expires.setUTCHours(0, 0, 0, 0);
      if (expires < today) return 'EXPIRED';
      const daysUntilExpiry = Math.ceil(
        (expires.getTime() - today.getTime()) / (1000 * 60 * 60 * 24),
      );
      if (daysUntilExpiry <= EXPIRY_WARNING_DAYS) return 'EXPIRING';
    }

    const current = Number(product.currentQuantity);
    if (current === 0) return 'EMPTY';

    const min = Number(product.minQuantity);
    if (min > 0 && current <= min) return 'LOW';

    return 'ACTIVE';
  }

  private serializeProduct<
    T extends {
      currentQuantity: Prisma.Decimal;
      minQuantity: Prisma.Decimal;
      isActive: boolean;
      expiresAt: Date | null;
    },
  >(product: T) {
    return {
      ...product,
      currentQuantity: Number(product.currentQuantity),
      minQuantity: Number(product.minQuantity),
      status: this.computeStatus(product),
    };
  }

  private parseDate(value: string): Date {
    return new Date(`${value}T00:00:00.000Z`);
  }
}
