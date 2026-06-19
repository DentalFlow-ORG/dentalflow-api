import { BadRequestException, Injectable } from '@nestjs/common';
import { StockMovementType } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { GetAbnormalConsumptionDto } from './dto/get-abnormal-consumption.dto';

export type AnomalyType =
  | 'CONSUMPTION_SPIKE'
  | 'LOSS_SPIKE'
  | 'FREQUENT_ADJUSTMENTS'
  | 'NEW_UNUSUAL_CONSUMPTION';

export type AnomalySeverity = 'HIGH' | 'MEDIUM' | 'LOW';

export type AbnormalConsumptionItem = {
  productId: string;
  productName: string;
  categoryName: string | null;
  currentQuantity: number;
  minQuantity: number;
  unit: string | null;
  anomalyType: AnomalyType;
  severity: AnomalySeverity;
  recentQuantity: number;
  baselineQuantity: number;
  changePercent: number | null;
  movementCount: number;
  reason: string;
  suggestedAction: string;
};

export type GetAbnormalConsumptionResult = {
  summary: {
    totalAnomalies: number;
    highSeverity: number;
    mediumSeverity: number;
    lowSeverity: number;
    recentDays: number;
    baselineDays: number;
    analyzedProducts: number;
    generatedAt: string;
  };
  items: AbnormalConsumptionItem[];
};

const SEVERITY_ORDER: Record<AnomalySeverity, number> = {
  HIGH: 0,
  MEDIUM: 1,
  LOW: 2,
};

type MovementBucket = {
  type: string;
  quantity: number;
  isRecent: boolean;
};

function sumQty(records: MovementBucket[]): number {
  return records.reduce((acc, r) => acc + r.quantity, 0);
}

@Injectable()
export class StockAbnormalConsumptionService {
  constructor(private readonly prisma: PrismaService) {}

  async getAbnormalConsumption(
    clinicId: string,
    dto: GetAbnormalConsumptionDto,
  ): Promise<GetAbnormalConsumptionResult> {
    const recentDays = dto.recentDays ?? 14;
    const baselineDays = dto.baselineDays ?? 60;

    if (recentDays >= baselineDays) {
      throw new BadRequestException(
        'recentDays deve ser menor que baselineDays.',
      );
    }

    const historicalDays = baselineDays - recentDays;
    const now = new Date();
    const windowStart = new Date(
      now.getTime() - baselineDays * 24 * 3600 * 1000,
    );
    const recentStart = new Date(
      now.getTime() - recentDays * 24 * 3600 * 1000,
    );

    // Sequential to avoid concurrent queries on the same pg connection
    // (would trigger the pg@8 "client already executing" deprecation warning).
    const movements = await this.prisma.stockMovement.findMany({
      where: { clinicId, createdAt: { gte: windowStart } },
      select: {
        productId: true,
        type: true,
        quantity: true,
        createdAt: true,
      },
    });
    const products = await this.prisma.stockProduct.findMany({
      where: { clinicId, isActive: true },
      select: {
        id: true,
        name: true,
        currentQuantity: true,
        minQuantity: true,
        unit: true,
        category: { select: { name: true } },
      },
    });

    const byProduct = new Map<string, MovementBucket[]>();
    for (const m of movements) {
      if (!byProduct.has(m.productId)) byProduct.set(m.productId, []);
      byProduct.get(m.productId)!.push({
        type: m.type,
        quantity: Number(m.quantity),
        isRecent: m.createdAt >= recentStart,
      });
    }

    const items: AbnormalConsumptionItem[] = [];

    for (const product of products) {
      const records = byProduct.get(product.id) ?? [];
      const currentQty = Number(product.currentQuantity);

      const recentOUT = records.filter(
        (r) => r.isRecent && r.type === StockMovementType.OUT,
      );
      const historicalOUT = records.filter(
        (r) => !r.isRecent && r.type === StockMovementType.OUT,
      );
      const recentLOSS = records.filter(
        (r) => r.isRecent && r.type === StockMovementType.LOSS,
      );
      const historicalLOSS = records.filter(
        (r) => !r.isRecent && r.type === StockMovementType.LOSS,
      );
      const recentADJ = records.filter(
        (r) => r.isRecent && r.type === StockMovementType.ADJUSTMENT,
      );
      const historicalADJ = records.filter(
        (r) => !r.isRecent && r.type === StockMovementType.ADJUSTMENT,
      );

      const recentOUTqty = sumQty(recentOUT);
      const historicalOUTqty = sumQty(historicalOUT);
      const recentLOSSqty = sumQty(recentLOSS);
      const historicalLOSSqty = sumQty(historicalLOSS);

      const base = {
        productId: product.id,
        productName: product.name,
        categoryName: product.category?.name ?? null,
        currentQuantity: currentQty,
        minQuantity: Number(product.minQuantity),
        unit: product.unit ?? null,
      };

      // ── CONSUMPTION_SPIKE ──────────────────────────────────────────
      if (historicalOUT.length >= 2 && recentOUTqty > 0) {
        const histRate = historicalOUTqty / historicalDays;
        const recRate = recentOUTqty / recentDays;
        if (histRate > 0) {
          const ratio = recRate / histRate;
          if (ratio >= 2.0) {
            const severity: AnomalySeverity = ratio >= 3.0 ? 'HIGH' : 'MEDIUM';
            const changePercent = Math.round((ratio - 1) * 100);
            items.push({
              ...base,
              anomalyType: 'CONSUMPTION_SPIKE',
              severity,
              recentQuantity: recentOUTqty,
              baselineQuantity: historicalOUTqty,
              changePercent,
              movementCount: recentOUT.length,
              reason: `Consumo ${changePercent}% acima da média histórica nos últimos ${recentDays} dias.`,
              suggestedAction:
                'Verifique se houve aumento de demanda ou uso indevido do produto.',
            });
          }
        }
      }

      // ── LOSS_SPIKE ─────────────────────────────────────────────────
      if (recentLOSS.length > 0) {
        if (historicalLOSS.length === 0) {
          const severity: AnomalySeverity =
            recentLOSS.length >= 3
              ? 'HIGH'
              : recentLOSS.length >= 2
                ? 'MEDIUM'
                : 'LOW';
          items.push({
            ...base,
            anomalyType: 'LOSS_SPIKE',
            severity,
            recentQuantity: recentLOSSqty,
            baselineQuantity: 0,
            changePercent: null,
            movementCount: recentLOSS.length,
            reason: `${recentLOSS.length} registro${recentLOSS.length > 1 ? 's' : ''} de perda nos últimos ${recentDays} dias sem histórico anterior.`,
            suggestedAction:
              'Investigue as causas das perdas e verifique armazenamento e validade.',
          });
        } else {
          const histRate = historicalLOSSqty / historicalDays;
          const recRate = recentLOSSqty / recentDays;
          if (histRate > 0) {
            const ratio = recRate / histRate;
            if (ratio >= 2.0) {
              const severity: AnomalySeverity =
                ratio >= 3.0 ? 'HIGH' : 'MEDIUM';
              const changePercent = Math.round((ratio - 1) * 100);
              items.push({
                ...base,
                anomalyType: 'LOSS_SPIKE',
                severity,
                recentQuantity: recentLOSSqty,
                baselineQuantity: historicalLOSSqty,
                changePercent,
                movementCount: recentLOSS.length,
                reason: `Perdas ${changePercent}% acima da média histórica nos últimos ${recentDays} dias.`,
                suggestedAction:
                  'Verifique armazenamento, validade e manuseio do produto.',
              });
            }
          }
        }
      }

      // ── FREQUENT_ADJUSTMENTS ───────────────────────────────────────
      if (recentADJ.length >= 2) {
        const severity: AnomalySeverity =
          recentADJ.length >= 3 ? 'HIGH' : 'MEDIUM';
        items.push({
          ...base,
          anomalyType: 'FREQUENT_ADJUSTMENTS',
          severity,
          recentQuantity: recentADJ.length,
          baselineQuantity: historicalADJ.length,
          changePercent: null,
          movementCount: recentADJ.length,
          reason: `${recentADJ.length} ajustes manuais realizados nos últimos ${recentDays} dias.`,
          suggestedAction:
            'Revise o processo de controle de estoque para reduzir a necessidade de ajustes.',
        });
      }

      // ── NEW_UNUSUAL_CONSUMPTION ────────────────────────────────────
      if (historicalOUT.length === 0 && recentOUTqty > 0) {
        const pctOfStock = currentQty > 0 ? recentOUTqty / currentQty : 1;
        const severity: AnomalySeverity =
          pctOfStock >= 0.5 || recentOUT.length >= 3
            ? 'HIGH'
            : pctOfStock >= 0.2 || recentOUT.length >= 2
              ? 'MEDIUM'
              : 'LOW';
        items.push({
          ...base,
          anomalyType: 'NEW_UNUSUAL_CONSUMPTION',
          severity,
          recentQuantity: recentOUTqty,
          baselineQuantity: 0,
          changePercent: null,
          movementCount: recentOUT.length,
          reason: `Produto sem histórico de saídas passou a ser consumido nos últimos ${recentDays} dias.`,
          suggestedAction:
            'Verifique se o uso deste produto é esperado e atualize o controle de demanda.',
        });
      }
    }

    items.sort((a, b) => {
      const sev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
      if (sev !== 0) return sev;
      return (b.changePercent ?? -1) - (a.changePercent ?? -1);
    });

    const highSeverity = items.filter((i) => i.severity === 'HIGH').length;
    const mediumSeverity = items.filter((i) => i.severity === 'MEDIUM').length;
    const lowSeverity = items.filter((i) => i.severity === 'LOW').length;

    return {
      summary: {
        totalAnomalies: items.length,
        highSeverity,
        mediumSeverity,
        lowSeverity,
        recentDays,
        baselineDays,
        analyzedProducts: products.length,
        generatedAt: now.toISOString(),
      },
      items,
    };
  }
}
