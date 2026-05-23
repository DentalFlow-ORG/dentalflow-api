import { Controller, Get, Query } from '@nestjs/common';
import { Roles } from '../../common/decorators/roles.decorator';
import { AuditLogService } from './audit-log.service';
import { ListAuditLogsDto } from './dto/list-audit-logs.dto';

@Controller('audit-logs')
@Roles('ADMIN')
export class AuditLogController {
  constructor(private readonly auditLogService: AuditLogService) {}

  @Get()
  list(@Query() dto: ListAuditLogsDto) {
    return this.auditLogService.list(dto);
  }
}
