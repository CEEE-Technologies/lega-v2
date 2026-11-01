import { Controller, Get, UseGuards } from '@nestjs/common';
import { GetDateFormatsService } from './queries/GetDateFormats.service';
import {
  ApiExtraModels,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { DateFormatResponseDto } from './dtos/DateFormatResponse.dto';

import { AllowAnyMember } from '@/modules/Roles/RequirePermission.decorator';
import { AuthorizationGuard } from '@/modules/Roles/Authorization.guard';
import { PermissionGuard } from '@/modules/Roles/Permission.guard';
@Controller('/')
@UseGuards(AuthorizationGuard, PermissionGuard)
@ApiTags('misc')
@ApiExtraModels(DateFormatResponseDto)
export class MiscellaneousController {
  constructor(private readonly getDateFormatsSevice: GetDateFormatsService) {}

  @Get('/date-formats')
  @AllowAnyMember()
  @ApiResponse({
    status: 200,
    schema: {
      type: 'array',
      items: { $ref: getSchemaPath(DateFormatResponseDto) },
    },
  })
  getDateFormats() {
    return this.getDateFormatsSevice.getDateFormats();
  }
}
