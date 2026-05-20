import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PlanFeature, getPlanFeatures } from './plan-feature.types';

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
}
