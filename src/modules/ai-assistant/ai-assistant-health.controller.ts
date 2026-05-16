import { Controller, Get, HttpCode, HttpStatus, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Roles } from '../../common/decorators/roles.decorator';
import { AiAssistantService } from './ai-assistant.service';
import { HealthQueryDto } from './dto/health-query.dto';

/**
 * Health check for AI Assistant configuration.
 *
 * Intentionally NOT @TenantScoped (ADMIN has no clinicId but needs access).
 * Intentionally NOT @RequiresBillingAccess (diagnostic endpoint, pre-billing).
 *
 * Without ?live=true  — zero OpenAI calls, zero tokens consumed.
 * With    ?live=true  — one minimal call (max 10 tokens), explicit opt-in only.
 */
@Controller('ai-assistant')
@Roles('OWNER', 'ADMIN')
@Throttle({ default: { ttl: 60_000, limit: 10 } })
export class AiAssistantHealthController {
  constructor(private readonly aiService: AiAssistantService) {}

  @Get('health')
  @HttpCode(HttpStatus.OK)
  async health(@Query() query: HealthQueryDto) {
    const config = this.aiService.getConfigStatus();

    if (!query.live) {
      return config;
    }

    if (!config.ready) {
      return {
        ...config,
        live: {
          ok: false,
          message: 'Assistente IA não está pronto — verifique a configuração.',
          durationMs: 0,
          model: null,
        },
      };
    }

    const ping = await this.aiService.pingOpenAi();
    return { ...config, live: ping };
  }
}
