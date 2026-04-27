import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class SpecialtiesService {
  constructor(private readonly prisma: PrismaService) {}

  findAll() {
    return this.prisma.specialty.findMany({
      select: { id: true, name: true, slug: true },
      orderBy: { name: 'asc' },
    });
  }
}
