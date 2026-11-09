import * as R from 'ramda';
import * as moment from 'moment';
import { first, sumBy } from 'lodash';
import { PromisePool } from '@supercharge/promise-pool';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  GetMatchedTransactionsFilter,
  MatchedTransactionsPOJO,
} from '../types';
import { GetMatchedTransactionsByExpenses } from './GetMatchedTransactionsByExpenses';
import { GetMatchedTransactionsByBills } from './GetMatchedTransactionsByBills.service';
import { GetMatchedTransactionsByManualJournals } from './GetMatchedTransactionsByManualJournals.service';
import { GetMatchedTransactionsByCashflow } from './GetMatchedTransactionsByCashflow';
import { GetMatchedTransactionsByInvoices } from './GetMatchedTransactionsByInvoices.service';
import { UncategorizedBankTransaction } from '@/modules/BankingTransactions/models/UncategorizedBankTransaction';
import {
  sortClosestMatchTransactions,
  validateUncategorizedTransactionsSameAccount,
} from '../_utils';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { Account } from '@/modules/Accounts/models/Account.model';

@Injectable()
export class GetMatchedTransactions {
  private readonly logger = new Logger(GetMatchedTransactions.name);

  constructor(
    private readonly getMatchedInvoicesService: GetMatchedTransactionsByInvoices,
    private readonly getMatchedBillsService: GetMatchedTransactionsByBills,
    private readonly getMatchedManualJournalService: GetMatchedTransactionsByManualJournals,
    private readonly getMatchedExpensesService: GetMatchedTransactionsByExpenses,
    private readonly getMatchedCashflowService: GetMatchedTransactionsByCashflow,

    @Inject(UncategorizedBankTransaction.name)
    private readonly uncategorizedBankTransactionModel: TenantModelProxy<
      typeof UncategorizedBankTransaction
    >,

    @Inject(Account.name)
    private readonly accountModel: TenantModelProxy<typeof Account>,
  ) {}

  /**
   * Registered matched transactions types.
   */
  get registered() {
    return [
      { type: 'SaleInvoice', service: this.getMatchedInvoicesService },
      { type: 'Bill', service: this.getMatchedBillsService },
      { type: 'Expense', service: this.getMatchedExpensesService },
      { type: 'ManualJournal', service: this.getMatchedManualJournalService },
      { type: 'Cashflow', service: this.getMatchedCashflowService },
    ];
  }

  /**
   * Retrieves the matched transactions.
   * @param {Array<number>} uncategorizedTransactionIds - Uncategorized transactions ids.
   * @param {GetMatchedTransactionsFilter} filter -
   * @returns {Promise<MatchedTransactionsPOJO>}
   */
  public async getMatchedTransactions(
    uncategorizedTransactionIds: Array<number>,
    filter: GetMatchedTransactionsFilter,
  ): Promise<MatchedTransactionsPOJO> {
    const uncategorizedTransactions =
      await this.uncategorizedBankTransactionModel()
        .query()
        .whereIn('id', uncategorizedTransactionIds)
        .throwIfNotFound();

    // Every matcher lists the transactions of one bank account.
    validateUncategorizedTransactionsSameAccount(uncategorizedTransactions);
    const accountId = first(uncategorizedTransactions)?.accountId;
    const account = await this.accountModel().query().findById(accountId);

    const filtered = filter.transactionType
      ? this.registered.filter((item) => item.type === filter.transactionType)
      : this.registered;

    const matchedTransactions = await PromisePool.withConcurrency(2)
      .for(filtered)
      .process(async ({ type: _type, service }) => {
        // Matchers list the bank account's own transactions, with their
        // amounts in the account's currency.
        return service.getMatchedTransactions({
          ...filter,
          accountId,
          accountCurrencyCode: account?.currencyCode,
        });
      });
    // A matcher that fails is left out of the list; log it, so a broken
    // matcher doesn't just quietly offer nothing.
    matchedTransactions.errors?.forEach((error) =>
      this.logger.error(
        `A ${error.item?.type} matcher failed: ${error.raw?.message ?? error.message}`,
        error.raw?.stack,
      ),
    );
    const { perfectMatches, possibleMatches } = this.groupMatchedResults(
      uncategorizedTransactions,
      matchedTransactions,
    );
    return {
      perfectMatches,
      possibleMatches,
      totalPending: sumBy(uncategorizedTransactions, 'amount'),
    };
  }

  /**
   * Groups the given results for getting perfect and possible matches
   * based on the given uncategorized transaction.
   * @param uncategorizedTransaction
   * @param matchedTransactions
   * @returns {MatchedTransactionsPOJO}
   */
  private groupMatchedResults(
    uncategorizedTransactions: Array<any>,
    matchedTransactions,
  ): MatchedTransactionsPOJO {
    const results = R.compose(R.flatten)(matchedTransactions?.results);

    const firstUncategorized = first(uncategorizedTransactions);
    const amount = sumBy(uncategorizedTransactions, 'amount');
    const date = firstUncategorized.date;

    // Sort the results based on amount, date, and transaction type
    const closestResullts = sortClosestMatchTransactions(amount, date, results);
    const perfectMatches = R.filter(
      (match) =>
        match.amount === amount && moment(match.date).isSame(date, 'day'),
      closestResullts,
    );
    const possibleMatches = R.difference(closestResullts, perfectMatches);
    const totalPending = sumBy(uncategorizedTransactions, 'amount');

    return { perfectMatches, possibleMatches, totalPending };
  }
}
