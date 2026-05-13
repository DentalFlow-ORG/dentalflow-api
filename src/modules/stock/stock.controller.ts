import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { RequiresBillingAccess } from '../../common/decorators/requires-billing-access.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { TenantScoped } from '../../common/decorators/tenant-scoped.decorator';
import { AccessPolicyService } from '../../common/services/access-policy.service';
import { AuthUser } from '../../common/types/auth-user.type';
import { CreateStockCategoryDto } from './dto/create-stock-category.dto';
import { UpdateStockCategoryDto } from './dto/update-stock-category.dto';
import { CreateStockProductDto } from './dto/create-stock-product.dto';
import { UpdateStockProductDto } from './dto/update-stock-product.dto';
import { ListStockProductsDto } from './dto/list-stock-products.dto';
import { CreateStockMovementDto } from './dto/create-stock-movement.dto';
import { ListStockMovementsDto } from './dto/list-stock-movements.dto';
import { StockService } from './stock.service';

@Controller('stock')
@TenantScoped()
@Roles('OWNER', 'ASSISTANT')
@RequiresBillingAccess()
export class StockController {
  constructor(
    private readonly stockService: StockService,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  // ── Categories ──────────────────────────────────────────────────

  @Get('categories')
  listCategories(@CurrentUser() user: AuthUser) {
    return this.stockService.listCategories(
      this.accessPolicy.assertOwnerOrAssistantAccess(user),
    );
  }

  @Post('categories')
  @Roles('OWNER')
  createCategory(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateStockCategoryDto,
  ) {
    return this.stockService.createCategory(
      this.accessPolicy.assertOwnerAccess(user),
      dto,
    );
  }

  @Patch('categories/:id')
  @Roles('OWNER')
  updateCategory(
    @CurrentUser() user: AuthUser,
    @Param('id') categoryId: string,
    @Body() dto: UpdateStockCategoryDto,
  ) {
    return this.stockService.updateCategory(
      this.accessPolicy.assertOwnerAccess(user),
      categoryId,
      dto,
    );
  }

  @Delete('categories/:id')
  @Roles('OWNER')
  @HttpCode(HttpStatus.NO_CONTENT)
  deleteCategory(
    @CurrentUser() user: AuthUser,
    @Param('id') categoryId: string,
  ) {
    return this.stockService.deleteCategory(
      this.accessPolicy.assertOwnerAccess(user),
      categoryId,
    );
  }

  // ── Summary ─────────────────────────────────────────────────────

  @Get('summary')
  getSummary(@CurrentUser() user: AuthUser) {
    return this.stockService.getSummary(
      this.accessPolicy.assertOwnerOrAssistantAccess(user),
    );
  }

  // ── Movements ───────────────────────────────────────────────────────────────

  @Get('movements')
  listMovements(
    @CurrentUser() user: AuthUser,
    @Query() query: ListStockMovementsDto,
  ) {
    return this.stockService.listMovements(
      this.accessPolicy.assertOwnerOrAssistantAccess(user),
      query,
    );
  }

  @Post('movements')
  createMovement(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateStockMovementDto,
  ) {
    return this.stockService.createMovement(
      this.accessPolicy.assertOwnerOrAssistantAccess(user),
      user.id,
      dto,
    );
  }

  // ── Products ────────────────────────────────────────────────────

  @Get('products')
  listProducts(
    @CurrentUser() user: AuthUser,
    @Query() query: ListStockProductsDto,
  ) {
    return this.stockService.listProducts(
      this.accessPolicy.assertOwnerOrAssistantAccess(user),
      query,
    );
  }

  @Get('products/:id/movements')
  listProductMovements(
    @CurrentUser() user: AuthUser,
    @Param('id') productId: string,
    @Query() query: ListStockMovementsDto,
  ) {
    return this.stockService.listProductMovements(
      this.accessPolicy.assertOwnerOrAssistantAccess(user),
      productId,
      query,
    );
  }

  @Get('products/:id')
  getProduct(
    @CurrentUser() user: AuthUser,
    @Param('id') productId: string,
  ) {
    return this.stockService.getProduct(
      this.accessPolicy.assertOwnerOrAssistantAccess(user),
      productId,
    );
  }

  @Post('products')
  createProduct(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateStockProductDto,
  ) {
    return this.stockService.createProduct(
      this.accessPolicy.assertOwnerOrAssistantAccess(user),
      dto,
    );
  }

  @Patch('products/:id')
  updateProduct(
    @CurrentUser() user: AuthUser,
    @Param('id') productId: string,
    @Body() dto: UpdateStockProductDto,
  ) {
    return this.stockService.updateProduct(
      this.accessPolicy.assertOwnerOrAssistantAccess(user),
      productId,
      dto,
    );
  }

  @Delete('products/:id')
  @Roles('OWNER')
  @HttpCode(HttpStatus.NO_CONTENT)
  deactivateProduct(
    @CurrentUser() user: AuthUser,
    @Param('id') productId: string,
  ) {
    return this.stockService.deactivateProduct(
      this.accessPolicy.assertOwnerAccess(user),
      productId,
    );
  }
}
