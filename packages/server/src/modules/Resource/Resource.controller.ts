import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { ResourceService } from './ResourceService';
import {
  ApiExtraModels,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ResourceMetaResponseDto } from './dtos/ResourceMetaResponse.dto';

import { AllowAnyMember } from '@/modules/Roles/RequirePermission.decorator';
import { AuthorizationGuard } from '@/modules/Roles/Authorization.guard';
import { PermissionGuard } from '@/modules/Roles/Permission.guard';
@Controller('resources')
@UseGuards(AuthorizationGuard, PermissionGuard)
@ApiTags('resources')
@ApiExtraModels(ResourceMetaResponseDto)
export class ResourceController {
  constructor(private readonly resourcesService: ResourceService) {}

  @Get('/:resourceModel/meta')
  @AllowAnyMember()
  @ApiOperation({ summary: 'Retrieves the resource meta' })
  @ApiParam({
    name: 'resourceModel',
    description: 'The resource model name (e.g., SaleInvoice, Customer, Item)',
    example: 'SaleInvoice',
    required: true,
  })
  @ApiResponse({
    status: 200,
    description: 'Retrieves the resource meta',
    schema: {
      $ref: getSchemaPath(ResourceMetaResponseDto),
    },
  })
  getResourceMeta(
    @Param('resourceModel') resourceModel: string,
  ): ResourceMetaResponseDto {
    const resourceMeta = this.resourcesService.getResourceMeta(resourceModel);

    return this.resourcesService.localizeResourceMeta(
      resourceMeta,
    ) as ResourceMetaResponseDto;
  }
}
