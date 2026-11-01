import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  getSchemaPath,
  ApiExtraModels,
} from '@nestjs/swagger';
import { Controller, Get, UseGuards } from '@nestjs/common';
import { DashboardService } from './Dashboard.service';
import { GetDashboardBootMetaResponseDto } from './dtos/GetDashboardBootMetaResponse.dto';

import { AllowAnyMember } from '@/modules/Roles/RequirePermission.decorator';
import { AuthorizationGuard } from '@/modules/Roles/Authorization.guard';
import { PermissionGuard } from '@/modules/Roles/Permission.guard';
@ApiTags('Dashboard')
@Controller('dashboard')
@UseGuards(AuthorizationGuard, PermissionGuard)
@ApiExtraModels(GetDashboardBootMetaResponseDto)
export class DashboardController {
  constructor(private readonly dashboardService: DashboardService) {}

  @ApiOperation({ summary: 'Get dashboard boot metadata' })
  @ApiResponse({
    status: 200,
    description: 'The dashboard details have been successfully retrieved.',
    schema: { $ref: getSchemaPath(GetDashboardBootMetaResponseDto) },
  })
  @Get('boot')
  @AllowAnyMember()
  getBootMeta() {
    return this.dashboardService.getBootMeta();
  }
}
