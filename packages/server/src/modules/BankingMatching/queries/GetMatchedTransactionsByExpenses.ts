import { Inject, Injectable } from '@nestjs/common';
import {
  GetMatchedTransactionsFilter,
  MatchedTransactionContext,
  MatchedTransactionPOJO,
  MatchedTransactionsPOJO,
} from '../types';
import { amountInAccountCurrency } from '../_utils';
import { GetMatchedTransactionsByType } from './GetMatchedTransactionsByType';
import { GetMatchedTransactionExpensesTransformer } from './GetMatchedTransactionExpensesTransformer';
import { TransformerInjectable } from '@/modules/Transformer/TransformerInjectable.service';
import { Expense } from '@/modules/Expenses/models/Expense.model';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { Knex } from 'knex';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';

@Injectable()
export class GetMatchedTransactionsByExpenses extends GetMatchedTransactionsByType {
  constructor(
    protected readonly transformer: TransformerInjectable,

    @Inject(Expense.name)
    protected readonly expenseModel: TenantModelProxy<typeof Expense>,

    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantDb: () => Knex,

    @Inject('TENANT_MODELS_INIT')
    private readonly tenantModelsInit: () => Promise<boolean>,
  ) {
    super();
  }

  /**
   * Retrieves the published, unmatched expenses paid from the bank account.
   * An expense's amount is what it moves on that account, in the account's
   * currency, so the min/max filters apply to that amount.
   * @param {GetMatchedTransactionsFilter} filter
   * @returns
   */
  async getMatchedTransactions(
    filter: GetMatchedTransactionsFilter,
  ): Promise<MatchedTransactionsPOJO> {
    const { accountCurrencyCode } = filter;

    // Retrieve the expense matches.
    const expenses = await this.expenseModel()
      .query()
      .onBuild((query) => {
        // Filter out the not matched to bank transactions.
        query.withGraphJoined('matchedBankTransaction');
        query.whereNull('matchedBankTransaction.id');

        // Filter the published onyl
        query.modify('filterByPublished');

        // Only the expenses paid from the bank line's account: matching
        // one paid from another account would mark this line as done
        // while its money never left this account in the books.
        if (filter.accountId) {
          query.where('paymentAccountId', filter.accountId);
        }
        if (filter.fromDate) {
          query.where('paymentDate', '>=', filter.fromDate);
        }
        if (filter.toDate) {
          query.where('paymentDate', '<=', filter.toDate);
        }
        query.orderBy('paymentDate', 'DESC');
      });

    const inRange = expenses.filter((expense) => {
      const amount = amountInAccountCurrency(
        expense.totalAmount,
        expense,
        accountCurrencyCode,
      );
      if (filter.minAmount && amount < filter.minAmount) return false;
      if (filter.maxAmount && amount > filter.maxAmount) return false;
      return true;
    });
    return this.transformer.transform(
      inRange,
      new GetMatchedTransactionExpensesTransformer(),
      { accountCurrencyCode },
    );
  }

  /**
   * Retrieves the given expense to match: published, not matched yet, and
   * paid from the bank line's account. Not found otherwise.
   * @param {number} transactionId
   * @param {MatchedTransactionContext} context - The bank line's account.
   * @returns {GetMatchedTransactionExpensesTransformer-}
   */
  public async getMatchedTransaction(
    transactionId: number,
    context?: MatchedTransactionContext,
  ): Promise<MatchedTransactionPOJO> {
    const query = this.expenseModel()
      .query()
      .findById(transactionId)
      .modify('filterByPublished')
      .whereNotExists(Expense.relatedQuery('matchedBankTransaction'));

    if (context?.accountId) {
      query.where('paymentAccountId', context.accountId);
    }
    const expense = await query.throwIfNotFound();

    return this.transformer.transform(
      expense,
      new GetMatchedTransactionExpensesTransformer(),
      { accountCurrencyCode: context?.accountCurrencyCode },
    );
  }
}
