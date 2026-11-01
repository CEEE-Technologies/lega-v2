import {
  Controller,
  Get,
  Query,
  UsePipes,
  ValidationPipe,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags, ApiResponse, ApiQuery } from '@nestjs/swagger';
import { ExchangeRateApplication } from './ExchangeRates.application';
import { ExchangeRateLatestQueryDto } from './dtos/ExchangeRateLatestQuery.dto';
import { ExchangeRateLatestResponseDto } from './dtos/ExchangeRateLatestResponse.dto';

import { AllowAnyMember } from '@/modules/Roles/RequirePermission.decorator';
import { AuthorizationGuard } from '@/modules/Roles/Authorization.guard';
import { PermissionGuard } from '@/modules/Roles/Permission.guard';
@Controller('exchange-rates')
@UseGuards(AuthorizationGuard, PermissionGuard)
@ApiTags('Exchange Rates')
export class ExchangeRatesController {
  constructor(private readonly exchangeRateApp: ExchangeRateApplication) {}

  @Get('/latest')
  @AllowAnyMember()
  @UsePipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  )
  @ApiOperation({ summary: 'Get the latest exchange rate' })
  @ApiQuery({
    name: 'from_currency',
    description: 'Source currency code (ISO 4217)',
    required: false,
    type: String,
    example: 'USD',
  })
  @ApiQuery({
    name: 'to_currency',
    description: 'Target currency code (ISO 4217)',
    required: false,
    type: String,
    example: 'EUR',
  })
  @ApiResponse({
    status: 200,
    description: 'Successfully retrieved exchange rate',
    type: ExchangeRateLatestResponseDto,
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid currency code or service error',
  })
  async getLatestExchangeRate(
    @Query() query: ExchangeRateLatestQueryDto,
  ): Promise<ExchangeRateLatestResponseDto> {
    const exchangeRate = await this.exchangeRateApp.latest({
      fromCurrency: query.from_currency,
      toCurrency: query.to_currency,
    });
    return exchangeRate;
  }
}
