import { events } from '@/common/events/events';
import { ERRORS } from '../constants';
import { OnEvent } from '@nestjs/event-emitter';
import { ServiceError } from '@/modules/Items/ServiceError';
import { Inject, Injectable } from '@nestjs/common';
import { UncategorizedBankTransaction } from '../models/UncategorizedBankTransaction';
import { ICommandCashflowDeletingPayload } from '../types/BankingTransactions.types';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { IExpenseDeletingPayload } from '@/modules/Expenses/interfaces/Expenses.interface';
import { Knex } from 'knex';

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
    await this.validateNoBankLineCategorizedTo(
      'CashflowTransaction',
      oldCashflowTransaction.id,
      trx,
    );
  }

  /**
   * Prevents deleting an expense a bank line was categorized to. Deleting it
   * would take the money out of the books while the bank line still says
   * "categorized" to nothing. Uncategorizing the line deletes the expense.
   * @param {IExpenseDeletingPayload} payload
   */
  @OnEvent(events.expenses.onDeleting)
  public async preventDeleteExpenseHasUncategorizedTransaction({
    oldExpense,
    trx,
  }: IExpenseDeletingPayload) {
    await this.validateNoBankLineCategorizedTo('Expense', oldExpense.id, trx);
  }

  /**
   * Refuses the delete while a bank line is categorized to the record.
   * Categorizing links the line to the record by the record's own id
   * (`categorizeRefType`/`categorizeRefId`); the record's
   * `uncategorizedTransactionId` is never set, so it isn't checked.
   * Uncategorizing frees the line first, so its own delete passes.
   */
  private async validateNoBankLineCategorizedTo(
    categorizeRefType: 'CashflowTransaction' | 'Expense',
    categorizeRefId: number,
    trx?: Knex.Transaction,
  ) {
    const foundTransactions = await this.uncategorizedBankTransactionModel()
      .query(trx)
      .where({
        categorized: true,
        categorizeRefId,
        categorizeRefType,
      });
    // Throw the error if the record is still linked to a bank line.
    if (foundTransactions.length > 0) {
      throw new ServiceError(
        ERRORS.CANNOT_DELETE_TRANSACTION_CONVERTED_FROM_UNCATEGORIZED,
        'This transaction was made from a bank line. Uncategorize the bank line instead.',
        { uncategorizedTransactionIds: foundTransactions.map((t) => t.id) },
      );
    }
  }
}
