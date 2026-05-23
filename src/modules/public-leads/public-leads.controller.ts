import { Body, Controller, HttpCode, HttpStatus, Ip, Post } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../common/decorators/public.decorator';
import { CreatePublicLeadDto } from './dto/create-public-lead.dto';
import { PublicLeadsService } from './public-leads.service';

@Public()
@Controller('public/leads')
export class PublicLeadsController {
  constructor(private readonly publicLeadsService: PublicLeadsService) {}

  @Post()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000 * 10, limit: 5 } })
  create(@Body() dto: CreatePublicLeadDto, @Ip() ip: string) {
    return this.publicLeadsService.create(dto, ip);
  }
}
