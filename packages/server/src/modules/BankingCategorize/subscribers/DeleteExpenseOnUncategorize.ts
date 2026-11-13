import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { events } from '@/common/events/events';
import { DeleteExpense } from '@/modules/Expenses/commands/DeleteExpense.service';
import { ICashflowTransactionUncategorizedPayload } from '../types/BankingCategorize.types';

/**
 * Uncategorizing a bank line that was categorized to an expense deletes that
 * expense, as it deletes a deposit (`DeleteCashflowTransactionOnUncategorize`).
 * Otherwise the expense would stay in the books and using the line again
 * would count the money twice.
 */
@Injectable()
export class DeleteExpenseOnUncategorizeSubscriber {
  constructor(private readonly deleteExpenseService: DeleteExpense) {}

  /**
   * Deletes the expense once the bank line is uncategorized.
   * @param {ICashflowTransactionUncategorizedPayload} payload
   */
  @OnEvent(events.cashflow.onTransactionUncategorized)
  public async deleteExpenseOnUncategorize({
    oldMainUncategorizedTransaction,
    trx,
  }: ICashflowTransactionUncategorizedPayload) {
    if (oldMainUncategorizedTransaction.categorizeRefType !== 'Expense') {
      return;
    }
    await this.deleteExpenseService.deleteExpense(
      oldMainUncategorizedTransaction.categorizeRefId,
      trx,
    );
  }
}
