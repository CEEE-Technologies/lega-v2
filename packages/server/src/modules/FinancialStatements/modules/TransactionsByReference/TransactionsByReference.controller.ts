import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { TransactionsByReferenceApplication } from './TransactionsByReferenceApplication';
import { TransactionsByReferenceQueryDto } from './TransactionsByReferenceQuery.dto';
import { TransactionsByReferenceResponseDto } from './TransactionsByReferenceResponse.dto';
import { NumberFormatQueryDto } from '@/modules/BankingTransactions/dtos/NumberFormatQuery.dto';

import { AbilitySubject } from '@/modules/Roles/Roles.types';
import { AuthorizationGuard } from '@/modules/Roles/Authorization.guard';
import { PermissionGuard } from '@/modules/Roles/Permission.guard';
import { ReportsAction } from '@/modules/FinancialStatements/types/Report.types';
import { RequirePermission } from '@/modules/Roles/RequirePermission.decorator';
@Controller('reports/transactions-by-reference')
@UseGuards(AuthorizationGuard, PermissionGuard)
@ApiTags('Reports')
@ApiExtraModels(NumberFormatQueryDto, TransactionsByReferenceResponseDto)
export class TransactionsByReferenceController {
  constructor(
    private readonly transactionsByReferenceApp: TransactionsByReferenceApplication,
  ) {}

  @Get()
  @RequirePermission(ReportsAction.READ_JOURNAL, AbilitySubject.Report)
  @ApiResponse({
    status: 200,
    description: 'Transactions by reference',
    schema: { $ref: getSchemaPath(TransactionsByReferenceResponseDto) },
  })
  @ApiOperation({ summary: 'Get transactions by reference' })
  @ApiQuery({
    name: 'numberFormat',
    required: false,
    description:
      'Number formatting options (serialized as bracket notation, e.g. numberFormat[precision]=2)',
    schema: { $ref: getSchemaPath(NumberFormatQueryDto) },
  })
  async getTransactionsByReference(
    @Query() query: TransactionsByReferenceQueryDto,
  ) {
    const data = await this.transactionsByReferenceApp.getTransactions(query);

    return data;
  }
}
