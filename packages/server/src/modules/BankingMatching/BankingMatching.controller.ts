import {
  ApiExtraModels,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { castArray } from 'lodash';
import { BankingMatchingApplication } from './BankingMatchingApplication';
import { MatchBankTransactionDto } from './dtos/MatchBankTransaction.dto';
import { GetMatchedTransactionsQueryDto } from './dtos/GetMatchedTransactionsQuery.dto';
import { GetMatchedTransactionsResponseDto } from './dtos/GetMatchedTransactionsResponse.dto';
import { ApiCommonHeaders } from '@/common/decorators/ApiCommonHeaders';

import { AbilitySubject } from '@/modules/Roles/Roles.types';
import { AuthorizationGuard } from '@/modules/Roles/Authorization.guard';
import { CashflowAction } from '@/modules/BankingTransactions/types/BankingTransactions.types';
import { PermissionGuard } from '@/modules/Roles/Permission.guard';
import { RequirePermission } from '@/modules/Roles/RequirePermission.decorator';
@Controller('banking/matching')
@UseGuards(AuthorizationGuard, PermissionGuard)
@ApiTags('Banking Transactions Matching')
@ApiExtraModels(GetMatchedTransactionsResponseDto)
@ApiCommonHeaders()
export class BankingMatchingController {
  constructor(
    private readonly bankingMatchingApplication: BankingMatchingApplication,
  ) {}

  @Get('matched')
  @RequirePermission(CashflowAction.View, AbilitySubject.Cashflow)
  @ApiOperation({ summary: 'Retrieves the matched transactions.' })
  @ApiQuery({
    name: 'uncategorizedTransactionIds',
    required: true,
    type: [Number],
    isArray: true,
    description: 'Uncategorized transaction IDs to match',
  })
  @ApiResponse({
    status: 200,
    description: 'Matched transactions (perfect and possible matches).',
    schema: { $ref: getSchemaPath(GetMatchedTransactionsResponseDto) },
  })
  async getMatchedTransactions(
    @Query('uncategorizedTransactionIds') uncategorizedTransactionIds: number[],
    @Query() filter: GetMatchedTransactionsQueryDto,
  ) {
    const ids = castArray(uncategorizedTransactionIds ?? []).map((id) =>
      Number(id),
    );

    return this.bankingMatchingApplication.getMatchedTransactions(
      ids,
      filter as any,
    );
  }

  @Post('/match')
  @RequirePermission(CashflowAction.Create, AbilitySubject.Cashflow)
  @ApiOperation({ summary: 'Match the given uncategorized transaction.' })
  async matchTransaction(@Body() matchedTransactions: MatchBankTransactionDto) {
    return this.bankingMatchingApplication.matchTransaction(
      matchedTransactions.uncategorizedTransactions,
      matchedTransactions.matchedTransactions,
    );
  }

  @Patch('/unmatch/:uncategorizedTransactionId')
  @RequirePermission(CashflowAction.Delete, AbilitySubject.Cashflow)
  @ApiOperation({ summary: 'Unmatch the given uncategorized transaction.' })
  async unmatchMatchedTransaction(
    @Param('uncategorizedTransactionId') uncategorizedTransactionId: number,
  ) {
    return this.bankingMatchingApplication.unmatchMatchedTransaction(
      uncategorizedTransactionId,
    );
  }
}
