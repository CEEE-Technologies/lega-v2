import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiExtraModels,
  getSchemaPath,
} from '@nestjs/swagger';
import { PaginatedResponseDto } from '@/common/dtos/PaginatedResults.dto';
import { ApiCommonHeaders } from '@/common/decorators/ApiCommonHeaders';
import { RecognizedTransactionsApplication } from './RecognizedTransactions.application';
import { GetRecognizedTransactionResponseDto } from './dtos/GetRecognizedTransactionResponse.dto';

import { AbilitySubject } from '@/modules/Roles/Roles.types';
import { AuthorizationGuard } from '@/modules/Roles/Authorization.guard';
import { CashflowAction } from '@/modules/BankingTransactions/types/BankingTransactions.types';
import { PermissionGuard } from '@/modules/Roles/Permission.guard';
import { RequirePermission } from '@/modules/Roles/RequirePermission.decorator';
@Controller('banking/recognized')
@UseGuards(AuthorizationGuard, PermissionGuard)
@ApiTags('Banking Recognized Transactions')
@ApiExtraModels(GetRecognizedTransactionResponseDto, PaginatedResponseDto)
@ApiCommonHeaders()
export class BankingRecognizedTransactionsController {
  constructor(
    private readonly recognizedTransactionsApplication: RecognizedTransactionsApplication,
  ) {}

  @Get(':recognizedTransactionId')
  @RequirePermission(CashflowAction.View, AbilitySubject.Cashflow)
  @ApiOperation({ summary: 'Get recognized transaction' })
  @ApiParam({
    name: 'recognizedTransactionId',
    description: 'The ID of the recognized transaction',
    type: 'number',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns the recognized transaction details',
    schema: {
      $ref: getSchemaPath(GetRecognizedTransactionResponseDto),
    },
  })
  @ApiResponse({
    status: 404,
    description: 'Recognized transaction not found',
  })
  async getRecognizedTransaction(
    @Param('recognizedTransactionId') recognizedTransactionId: number,
  ) {
    return this.recognizedTransactionsApplication.getRecognizedTransaction(
      Number(recognizedTransactionId),
    );
  }

  @Get()
  @RequirePermission(CashflowAction.View, AbilitySubject.Cashflow)
  @ApiOperation({ summary: 'Get a list of recognized transactions' })
  @ApiQuery({
    name: 'query',
    required: false,
    description: 'Query parameters for filtering recognized transactions',
  })
  @ApiResponse({
    status: 200,
    description: 'Returns a list of recognized transactions',
    schema: {
      allOf: [
        { $ref: getSchemaPath(PaginatedResponseDto) },
        {
          properties: {
            data: {
              type: 'array',
              items: {
                $ref: getSchemaPath(GetRecognizedTransactionResponseDto),
              },
            },
          },
        },
      ],
    },
  })
  async getRecognizedTransactions(@Query() query: any) {
    return this.recognizedTransactionsApplication.getRecognizedTransactions(
      query,
    );
  }
}
