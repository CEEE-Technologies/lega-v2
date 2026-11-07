import { events } from '@/common/events/events';
import { ERRORS } from '../constants';
import { OnEvent } from '@nestjs/event-emitter';
import { ServiceError } from '@/modules/Items/ServiceError';
import { Inject, Injectable } from '@nestjs/common';
import { UncategorizedBankTransaction } from '../models/UncategorizedBankTransaction';
import { ICommandCashflowDeletingPayload } from '../types/BankingTransactions.types';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';

@Injectable()
export class PreventDeleteTransactionOnDeleteSubscriber {
  constructor(
    @Inject(UncategorizedBankTransaction.name)
    private readonly uncategorizedBankTransactionModel: TenantModelProxy<
      typeof UncategorizedBankTransaction
    >,
  ) {}

  /**
   * Prevent delete cashflow transaction has converted from uncategorized transaction.
   * @param {ICommandCashflowDeletingPayload} payload
   */
  @OnEvent(events.cashflow.onTransactionDeleting)
  public async preventDeleteCashflowTransactionHasUncategorizedTransaction({
    oldCashflowTransaction,
    trx,
  }: ICommandCashflowDeletingPayload) {
    // Categorizing links the bank line to the deposit by the deposit's own
    // id (`categorizeRefType`/`categorizeRefId`); the deposit's
    // `uncategorizedTransactionId` is never set, so it isn't checked here.
    // Uncategorizing frees the line first, so its own delete passes.
    const foundTransactions = await this.uncategorizedBankTransactionModel()
      .query(trx)
      .where({
        categorized: true,
        categorizeRefId: oldCashflowTransaction.id,
        categorizeRefType: 'CashflowTransaction',
      });
    // Throw the error if the cashflow transaction still linked to uncategorized transaction.
    if (foundTransactions.length > 0) {
      throw new ServiceError(
        ERRORS.CANNOT_DELETE_TRANSACTION_CONVERTED_FROM_UNCATEGORIZED,
        'This transaction was made from a bank line. Uncategorize the bank line instead.',
        { uncategorizedTransactionIds: foundTransactions.map((t) => t.id) },
      );
    }
  }
}
