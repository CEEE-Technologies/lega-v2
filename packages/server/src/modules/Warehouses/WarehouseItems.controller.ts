import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { WarehousesApplication } from './WarehousesApplication.service';
import {
  ApiExtraModels,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ApiCommonHeaders } from '@/common/decorators/ApiCommonHeaders';
import { ItemWarehousesResponseDto } from './Items/dtos/ItemWarehousesResponse.dto';

import { AbilitySubject } from '@/modules/Roles/Roles.types';
import { AuthorizationGuard } from '@/modules/Roles/Authorization.guard';
import { ItemAction } from '@/interfaces/Item';
import { PermissionGuard } from '@/modules/Roles/Permission.guard';
import { RequirePermission } from '@/modules/Roles/RequirePermission.decorator';
@Controller('items')
@UseGuards(AuthorizationGuard, PermissionGuard)
@ApiTags('Warehouses')
@ApiCommonHeaders()
@ApiExtraModels(ItemWarehousesResponseDto)
export class WarehouseItemsController {
  constructor(private warehousesApplication: WarehousesApplication) {}

  @Get(':id/warehouses')
  @RequirePermission(ItemAction.VIEW, AbilitySubject.Item)
  @ApiOperation({
    summary: 'Retrieves the item associated warehouses.',
  })
  @ApiResponse({
    status: 200,
    description:
      'The item associated warehouses have been successfully retrieved.',
    schema: {
      type: 'array',
      items: { $ref: getSchemaPath(ItemWarehousesResponseDto) },
    },
  })
  @ApiResponse({ status: 404, description: 'The item not found.' })
  @ApiParam({
    name: 'id',
    required: true,
    type: Number,
    description: 'The item id',
  })
  getItemWarehouses(@Param('id') itemId: string) {
    return this.warehousesApplication.getItemWarehouses(Number(itemId));
  }
}
