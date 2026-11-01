import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { GetItemsInventoryValuationListService } from './queries/GetItemsInventoryValuationList.service';
import { GetInventoyItemsCostQueryDto } from './dtos/GetInventoryItemsCostQuery.dto';
import { GetInventoryItemsCostResponseDto } from './dtos/GetInventoryItemsCostResponse.dto';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ApiCommonHeaders } from '@/common/decorators/ApiCommonHeaders';

import { AbilitySubject } from '@/modules/Roles/Roles.types';
import { AuthorizationGuard } from '@/modules/Roles/Authorization.guard';
import { ItemAction } from '@/interfaces/Item';
import { PermissionGuard } from '@/modules/Roles/Permission.guard';
import { RequirePermission } from '@/modules/Roles/RequirePermission.decorator';
@Controller('inventory-cost')
@UseGuards(AuthorizationGuard, PermissionGuard)
@ApiTags('Inventory Cost')
@ApiCommonHeaders()
export class InventoryCostController {
  constructor(
    private readonly inventoryItemCost: GetItemsInventoryValuationListService,
  ) {}

  @Get('items')
  @RequirePermission(ItemAction.VIEW, AbilitySubject.Item)
  @ApiOperation({ summary: 'Get items inventory valuation list' })
  @ApiResponse({
    status: 200,
    description: 'Items inventory cost list',
    type: GetInventoryItemsCostResponseDto,
  })
  async getItemsCost(
    @Query() itemsCostsQueryDto: GetInventoyItemsCostQueryDto,
  ): Promise<GetInventoryItemsCostResponseDto> {
    const costs = await this.inventoryItemCost.getItemsInventoryValuationList(
      itemsCostsQueryDto.itemsIds,
      itemsCostsQueryDto.date,
    );
    return { costs };
  }
}
