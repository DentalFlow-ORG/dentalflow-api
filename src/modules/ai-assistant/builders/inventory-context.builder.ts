import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { StockService } from '../../stock/stock.service';
import { brazilTodayIso } from '../../../common/utils/brazil-timezone';

export type InventoryAiContext = {
  generatedAt: string;
  currency: 'BRL';
  summary: {
    totalActive: number;
    lowStock: number;
    emptyStock: number;
    expiring: number;
    expired: number;
    inactive: number;
    estimatedValue: number;
    totalCategories: number;
  };
  criticalProducts: Array<{
    name: string;
    status: string;
    currentQuantity: number;
    minQuantity: number;
    unit: string;
    categoryName: string;
  }>;
  categoryBreakdown: Array<{
    categoryName: string;
    totalProducts: number;
    criticalCount: number;
  }>;
  limitations: string[];
};

const EXPIRY_WARNING_DAYS = 30;

function computeStatus(product: {
  isActive: boolean;
  currentQuantity: Prisma.Decimal;
  minQuantity: Prisma.Decimal;
  expiresAt: Date | null;
}): string {
  if (!product.isActive) return 'INACTIVE';
  // expiresAt is stored as UTC midnight of the calendar date. Use UTC midnight
  // of the Brazil today date so items expiring "today Brazil" are not shown
  // as EXPIRED at 00:00-02:59 UTC when Brazil is still the previous day.
  const today = new Date(`${brazilTodayIso()}T00:00:00.000Z`);
  if (product.expiresAt) {
    const expires = new Date(product.expiresAt);
    if (expires < today) return 'EXPIRED';
    const days = Math.ceil((expires.getTime() - today.getTime()) / 86_400_000);
    if (days <= EXPIRY_WARNING_DAYS) return 'EXPIRING';
  }
  const current = Number(product.currentQuantity);
  if (current === 0) return 'EMPTY';
  const min = Number(product.minQuantity);
  if (min > 0 && current <= min) return 'LOW';
  return 'ACTIVE';
}

const STATUS_PRIORITY: Record<string, number> = {
  EMPTY: 0,
  EXPIRED: 1,
  EXPIRING: 2,
  LOW: 3,
  ACTIVE: 4,
  INACTIVE: 5,
};

@Injectable()
export class InventoryContextBuilder {
  constructor(
    private readonly stockService: StockService,
    private readonly prisma: PrismaService,
  ) {}

  async build(clinicId: string): Promise<InventoryAiContext> {
    // Sequential to avoid concurrent pg queries on the same connection.
    const summary = await this.stockService.getSummary(clinicId);
    const rawProducts = await this.prisma.stockProduct.findMany({
      where: { clinicId, isActive: true },
      include: { category: { select: { name: true } } },
      orderBy: { currentQuantity: 'asc' },
    });

    const limitations: string[] = [];
    if (summary.totalActive === 0) {
      limitations.push('Nenhum produto ativo cadastrado.');
    }
    if (summary.estimatedValue === 0) {
      limitations.push(
        'Valor estimado indisponível — preço de compra não cadastrado em todos os produtos.',
      );
    }

    // Compute status for all products in-memory (same logic as StockService)
    const withStatus = rawProducts.map((p) => ({
      name: p.name,
      unit: p.unit,
      status: computeStatus(p),
      currentQuantity: Number(p.currentQuantity),
      minQuantity: Number(p.minQuantity),
      categoryName: p.category?.name ?? 'Sem categoria',
    }));

    // Top 10 critical products sorted by priority
    const criticalProducts = withStatus
      .filter((p) => ['EMPTY', 'EXPIRED', 'EXPIRING', 'LOW'].includes(p.status))
      .sort(
        (a, b) =>
          (STATUS_PRIORITY[a.status] ?? 99) - (STATUS_PRIORITY[b.status] ?? 99),
      )
      .slice(0, 10);

    // Category breakdown: total products + critical count per category
    const categoryMap = new Map<
      string,
      { totalProducts: number; criticalCount: number }
    >();
    for (const p of withStatus) {
      const entry = categoryMap.get(p.categoryName) ?? {
        totalProducts: 0,
        criticalCount: 0,
      };
      entry.totalProducts++;
      if (['EMPTY', 'EXPIRED', 'EXPIRING', 'LOW'].includes(p.status)) {
        entry.criticalCount++;
      }
      categoryMap.set(p.categoryName, entry);
    }
    const categoryBreakdown = [...categoryMap.entries()]
      .map(([categoryName, counts]) => ({ categoryName, ...counts }))
      .sort((a, b) => b.criticalCount - a.criticalCount);

    return {
      generatedAt: new Date().toISOString(),
      currency: 'BRL',
      summary,
      criticalProducts,
      categoryBreakdown,
      limitations,
    };
  }
}
