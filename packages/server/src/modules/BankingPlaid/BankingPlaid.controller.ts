import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { PlaidApplication } from './PlaidApplication';
import { PlaidItemDto } from './dtos/PlaidItem.dto';
import { ApiOperation, ApiTags } from '@nestjs/swagger';

import { AbilitySubject } from '@/modules/Roles/Roles.types';
import { AuthorizationGuard } from '@/modules/Roles/Authorization.guard';
import { CashflowAction } from '@/modules/BankingTransactions/types/BankingTransactions.types';
import { PermissionGuard } from '@/modules/Roles/Permission.guard';
import { RequirePermission } from '@/modules/Roles/RequirePermission.decorator';
@Controller('banking/plaid')
@UseGuards(AuthorizationGuard, PermissionGuard)
@ApiTags('Banking Plaid')
export class BankingPlaidController {
  constructor(private readonly plaidApplication: PlaidApplication) {}

  @Post('link-token')
  @RequirePermission(CashflowAction.Create, AbilitySubject.Cashflow)
  @ApiOperation({ summary: 'Get Plaid link token' })
  getLinkToken() {
    return this.plaidApplication.getLinkToken();
  }

  @Post('exchange-token')
  @RequirePermission(CashflowAction.Create, AbilitySubject.Cashflow)
  @ApiOperation({ summary: 'Exchange Plaid access token' })
  exchangeToken(@Body() itemDTO: PlaidItemDto) {
    return this.plaidApplication.exchangeToken(itemDTO);
  }
}
