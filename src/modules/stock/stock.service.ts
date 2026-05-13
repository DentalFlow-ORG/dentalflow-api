import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, StockMovementType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateStockCategoryDto } from './dto/create-stock-category.dto';
import { UpdateStockCategoryDto } from './dto/update-stock-category.dto';
import { CreateStockProductDto } from './dto/create-stock-product.dto';
import { UpdateStockProductDto } from './dto/update-stock-product.dto';
import { CreateStockMovementDto } from './dto/create-stock-movement.dto';
import { ListStockMovementsDto } from './dto/list-stock-movements.dto';
import {
  ListStockProductsDto,
  StockProductStatus,
} from './dto/list-stock-products.dto';

const EXPIRY_WARNING_DAYS = 30;

const MOVEMENT_INCLUDE = {
  product: {
    select: {
      id: true,
      name: true,
      unit: true,
      category: { select: { id: true, name: true } },
    },
  },
  performedBy: {
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
    },
  },
} as const;

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

  // ── Movements ───────────────────────────────────────────────────────────────

  async listMovements(clinicId: string, query: ListStockMovementsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where = this.buildMovementWhere(clinicId, query);

    const [data, total] = await this.prisma.$transaction([
      this.prisma.stockMovement.findMany({
        where,
        include: MOVEMENT_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.stockMovement.count({ where }),
    ]);

    return {
      data: data.map((movement) => this.serializeMovement(movement)),
      total,
      page,
      limit,
    };
  }

  async listProductMovements(
    clinicId: string,
    productId: string,
    query: ListStockMovementsDto,
  ) {
    await this.assertProduct(clinicId, productId);
    return this.listMovements(clinicId, { ...query, productId });
  }

  async createMovement(
    clinicId: string,
    performedByUserId: string,
    dto: CreateStockMovementDto,
  ) {
    this.assertMovementPayload(dto);

    const movement = await this.prisma.$transaction(async (tx) => {
      const product = await tx.stockProduct.findFirst({
        where: { id: dto.productId, clinicId },
      });

      if (!product) {
        throw new NotFoundException('Produto não encontrado.');
      }

      if (!product.isActive) {
        throw new BadRequestException(
          'Não é possível movimentar um produto inativo.',
        );
      }

      const { previousQuantity, quantity, newQuantity } =
        this.calculateMovementQuantities(product.currentQuantity, dto);

      if (newQuantity.isNegative()) {
        throw new BadRequestException(
          'A movimentação não pode deixar o estoque negativo.',
        );
      }

      await tx.stockProduct.update({
        where: { id: product.id },
        data: { currentQuantity: newQuantity },
      });

      return tx.stockMovement.create({
        data: {
          clinicId,
          productId: product.id,
          type: dto.type,
          quantity,
          previousQuantity,
          newQuantity,
          reason: dto.reason,
          notes: dto.notes,
          performedByUserId,
        },
        include: MOVEMENT_INCLUDE,
      });
    });

    return this.serializeMovement(movement);
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

  private buildMovementWhere(
    clinicId: string,
    query: ListStockMovementsDto,
  ): Prisma.StockMovementWhereInput {
    return {
      clinicId,
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.type ? { type: query.type } : {}),
      ...this.createdAtRange(query.dateFrom, query.dateTo),
    };
  }

  private createdAtRange(
    dateFrom?: string,
    dateTo?: string,
  ): Pick<Prisma.StockMovementWhereInput, 'createdAt'> {
    if (!dateFrom && !dateTo) {
      return {};
    }

    return {
      createdAt: {
        ...(dateFrom ? { gte: this.startOfDay(dateFrom) } : {}),
        ...(dateTo ? { lte: this.endOfDay(dateTo) } : {}),
      },
    };
  }

  private assertMovementPayload(dto: CreateStockMovementDto) {
    const hasQuantity = dto.quantity !== undefined;
    const hasNewQuantity = dto.newQuantity !== undefined;

    if (dto.type === StockMovementType.ADJUSTMENT) {
      if (!hasNewQuantity) {
        throw new BadRequestException('Informe a quantidade final do ajuste.');
      }

      if (hasQuantity) {
        throw new BadRequestException(
          'Ajustes devem informar apenas a quantidade final.',
        );
      }

      return;
    }

    if (!hasQuantity || dto.quantity === 0) {
      throw new BadRequestException('Informe uma quantidade maior que zero.');
    }

    if (hasNewQuantity) {
      throw new BadRequestException(
        'Entradas, saídas e perdas devem informar apenas a quantidade movimentada.',
      );
    }
  }

  private calculateMovementQuantities(
    currentQuantity: Prisma.Decimal,
    dto: CreateStockMovementDto,
  ) {
    const previousQuantity = new Prisma.Decimal(currentQuantity);

    if (dto.type === StockMovementType.ADJUSTMENT) {
      const newQuantity = new Prisma.Decimal(dto.newQuantity ?? 0);
      return {
        previousQuantity,
        quantity: newQuantity.minus(previousQuantity).abs(),
        newQuantity,
      };
    }

    const quantity = new Prisma.Decimal(dto.quantity ?? 0);
    const isIncrease = dto.type === StockMovementType.IN;
    const newQuantity = isIncrease
      ? previousQuantity.plus(quantity)
      : previousQuantity.minus(quantity);

    return {
      previousQuantity,
      quantity,
      newQuantity,
    };
  }

  private serializeMovement<
    T extends {
      quantity: Prisma.Decimal;
      previousQuantity: Prisma.Decimal;
      newQuantity: Prisma.Decimal;
    },
  >(movement: T) {
    return {
      ...movement,
      quantity: Number(movement.quantity),
      previousQuantity: Number(movement.previousQuantity),
      newQuantity: Number(movement.newQuantity),
    };
  }

  private parseDate(value: string): Date {
    return new Date(`${value}T00:00:00.000Z`);
  }

  private startOfDay(value: string): Date {
    return new Date(`${value}T00:00:00.000Z`);
  }

  private endOfDay(value: string): Date {
    return new Date(`${value}T23:59:59.999Z`);
  }
}
