import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlanFeature, getPlanFeatures } from './plan-feature.types';

export interface UserLimitUsage {
  limit: number;
  used: number;
  remaining: number;
  planSlug: string;
  planName: string | null;
}

@Injectable()
export class PlanCapabilitiesService {
  constructor(private readonly prisma: PrismaService) {}

  async getPlanSlug(clinicId: string): Promise<string | null> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { clinicId },
      select: { plan: { select: { slug: true } } },
    });
    return subscription?.plan?.slug ?? null;
  }

  async assertFeature(clinicId: string, feature: PlanFeature): Promise<void> {
    const slug = await this.getPlanSlug(clinicId);
    const features = getPlanFeatures(slug);
    if (!features.has(feature)) {
      throw new ForbiddenException(
        'Este recurso não está disponível no seu plano atual. Faça upgrade para continuar.',
      );
    }
  }

  async getUserLimitUsage(clinicId: string): Promise<UserLimitUsage> {
    const subscription = await this.prisma.subscription.findUnique({
      where: { clinicId },
      select: {
        plan: {
          select: {
            slug: true,
            name: true,
            maxUsersPerClinic: true,
          },
        },
      },
    });

    if (!subscription?.plan) {
      throw new ForbiddenException(
        'Plano não encontrado para esta clínica. Entre em contato com o suporte.',
      );
    }

    const limit = subscription.plan.maxUsersPerClinic;
    if (limit <= 0) {
      throw new ForbiddenException(
        'Configuração de limite de usuários inválida. Entre em contato com o suporte.',
      );
    }

    const used = await this.prisma.user.count({
      where: {
        clinicId,
        isActive: true,
        deletedAt: null,
      },
    });

    return {
      limit,
      used,
      remaining: Math.max(0, limit - used),
      planSlug: subscription.plan.slug,
      planName: subscription.plan.name,
    };
  }

  async assertUserLimitAvailable(clinicId: string): Promise<void> {
    const usage = await this.getUserLimitUsage(clinicId);
    if (usage.remaining <= 0) {
      throw new ForbiddenException(
        'Limite de usuários do plano atingido. Faça upgrade para adicionar mais membros à clínica.',
      );
    }
  }
}
