import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { GetResourceViewsService } from './GetResourceViews.service';
import { ViewResponseDto } from './dtos/ViewResponse.dto';

import { AllowAnyMember } from '@/modules/Roles/RequirePermission.decorator';
import { AuthorizationGuard } from '@/modules/Roles/Authorization.guard';
import { PermissionGuard } from '@/modules/Roles/Permission.guard';
@Controller('views')
@UseGuards(AuthorizationGuard, PermissionGuard)
@ApiTags('Views')
@ApiExtraModels(ViewResponseDto)
export class ViewsController {
  constructor(
    private readonly getResourceViewsService: GetResourceViewsService,
  ) {}

  @Get('/resource/:resourceModel')
  @AllowAnyMember()
  @ApiParam({
    name: 'resourceModel',
    description: 'The resource model to get views for',
    type: String,
  })
  @ApiResponse({
    status: 200,
    description: 'Specific resource views',
    schema: { $ref: getSchemaPath(ViewResponseDto) },
  })
  @ApiOperation({ summary: 'Get the given resource views' })
  async getResourceViews(@Param('resourceModel') resourceModel: string) {
    const views =
      await this.getResourceViewsService.getResourceViews(resourceModel);
    return views;
  }
}
