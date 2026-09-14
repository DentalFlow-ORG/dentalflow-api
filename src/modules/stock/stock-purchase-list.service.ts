import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

export type PurchasePriority = 'CRITICAL' | 'HIGH' | 'MEDIUM';

export interface PurchaseListItem {
  productId: string;
  productName: string;
  categoryName: string | null;
  supplier: string | null;
  currentQuantity: number;
  minQuantity: number;
  unit: string | null;
  deficitQuantity: number;
  suggestedPurchaseQuantity: number;
  estimatedCostCents: number | null;
  priority: PurchasePriority;
  reason: string;
}

export interface PurchaseListResult {
  summary: {
    totalItems: number;
    criticalItems: number;
    highPriorityItems: number;
    mediumPriorityItems: number;
    totalEstimatedCostCents: number;
  };
  items: PurchaseListItem[];
}

const PRIORITY_WEIGHT: Record<PurchasePriority, number> = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
};

@Injectable()
export class StockPurchaseListService {
  constructor(private readonly prisma: PrismaService) {}

  async getPurchaseList(clinicId: string): Promise<PurchaseListResult> {
    const products = await this.prisma.stockProduct.findMany({
      where: { clinicId, isActive: true },
      include: { category: { select: { id: true, name: true } } },
      orderBy: { name: 'asc' },
    });

    const items = products
      .filter((p) => Number(p.currentQuantity) <= Number(p.minQuantity))
      .map((p) => this.buildItem(p))
      .sort(compareItems);

    return { summary: this.buildSummary(items), items };
  }

  private buildItem(product: {
    id: string;
    name: string;
    currentQuantity: Prisma.Decimal;
    minQuantity: Prisma.Decimal;
    purchasePrice: number | null;
    supplier: string | null;
    unit: string | null;
    category: { name: string } | null;
  }): PurchaseListItem {
    const current = Number(product.currentQuantity);
    const min = Number(product.minQuantity);
    const priority = this.classifyPriority(current, min);
    const deficitQuantity = Math.max(min - current, 0);
    const suggestedPurchaseQuantity = deficitQuantity;
    const estimatedCostCents =
      product.purchasePrice !== null
        ? Math.round(suggestedPurchaseQuantity * product.purchasePrice)
        : null;

    return {
      productId: product.id,
      productName: product.name,
      categoryName: product.category?.name ?? null,
      supplier: product.supplier,
      currentQuantity: current,
      minQuantity: min,
      unit: product.unit,
      deficitQuantity,
      suggestedPurchaseQuantity,
      estimatedCostCents,
      priority,
      reason: this.buildReason(current, min),
    };
  }

  private classifyPriority(current: number, min: number): PurchasePriority {
    if (current <= 0) return 'CRITICAL';
    if (min > 0) {
      const ratio = current / min;
      if (ratio <= 0.25) return 'CRITICAL';
      if (ratio <= 0.5) return 'HIGH';
    }
    return 'MEDIUM';
  }

  private buildReason(current: number, min: number): string {
    if (current <= 0) return 'Produto esgotado.';
    if (min > 0) {
      const ratio = current / min;
      if (ratio <= 0.25) return 'Estoque abaixo de 25% do mínimo definido.';
      if (ratio <= 0.5) return 'Estoque abaixo de 50% do mínimo definido.';
    }
    return 'Estoque abaixo do mínimo definido.';
  }

  private buildSummary(
    items: PurchaseListItem[],
  ): PurchaseListResult['summary'] {
    let criticalItems = 0;
    let highPriorityItems = 0;
    let mediumPriorityItems = 0;
    let totalEstimatedCostCents = 0;

    for (const item of items) {
      if (item.priority === 'CRITICAL') criticalItems++;
      else if (item.priority === 'HIGH') highPriorityItems++;
      else mediumPriorityItems++;

      totalEstimatedCostCents += item.estimatedCostCents ?? 0;
    }

    return {
      totalItems: items.length,
      criticalItems,
      highPriorityItems,
      mediumPriorityItems,
      totalEstimatedCostCents,
    };
  }
}

/** Most urgent first: priority, then how far below the minimum, then name. */
function compareItems(a: PurchaseListItem, b: PurchaseListItem): number {
  const weightDiff = PRIORITY_WEIGHT[a.priority] - PRIORITY_WEIGHT[b.priority];
  if (weightDiff !== 0) return weightDiff;

  const ratioA = a.minQuantity > 0 ? a.currentQuantity / a.minQuantity : 0;
  const ratioB = b.minQuantity > 0 ? b.currentQuantity / b.minQuantity : 0;
  if (ratioA !== ratioB) return ratioA - ratioB;

  return a.productName.localeCompare(b.productName, 'pt-BR');
}
