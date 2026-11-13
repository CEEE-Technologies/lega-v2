import { Inject, Injectable } from '@nestjs/common';
import { GetMatchedTransactionManualJournalsTransformer } from './GetMatchedTransactionManualJournalsTransformer';
import { GetMatchedTransactionsByType } from './GetMatchedTransactionsByType';
import {
  GetMatchedTransactionsFilter,
  MatchedTransactionContext,
} from '../types';
import { bankAccountNet } from '../_utils';
import { ManualJournal } from '@/modules/ManualJournals/models/ManualJournal';
import { TransformerInjectable } from '@/modules/Transformer/TransformerInjectable.service';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';

@Injectable()
export class GetMatchedTransactionsByManualJournals extends GetMatchedTransactionsByType {
  constructor(
    private readonly transformer: TransformerInjectable,

    @Inject(ManualJournal.name)
    private readonly manualJournalModel: TenantModelProxy<typeof ManualJournal>,
  ) {
    super();
  }

  /**
   * Retrieves the published, unmatched manual journals with a line on the
   * bank account. A journal's amount is what it moves on that account
   * (debit - credit of those lines: a debit is money in), in the account's
   * currency, so the min/max filters apply to that amount, not to the
   * journal total.
   * @param {GetMatchedTransactionsFilter} filter
   */
  async getMatchedTransactions(
    filter: Omit<GetMatchedTransactionsFilter, 'transactionType'>,
  ) {
    const accountId = filter.accountId;
    if (!accountId) return [];
    const { accountCurrencyCode } = filter;

    // Not a joined graph: `withGraphJoined` inside `onBuild` failed every
    // time ("table metadata has not been fetched"), and the error was
    // dropped with the other matchers' results, so no journal was offered.
    const query = this.manualJournalModel()
      .query()
      .modify('filterByPublished')
      .whereNotExists(ManualJournal.relatedQuery('matchedBankTransaction'))
      .whereExists(
        ManualJournal.relatedQuery('entries').where('accountId', accountId),
      )
      // Only the lines on the bank account: they make the amount.
      .withGraphFetched('entries')
      .modifyGraph('entries', (builder) => {
        builder.where('accountId', accountId);
      });
    if (filter.fromDate) {
      query.where('date', '>=', filter.fromDate);
    }
    if (filter.toDate) {
      query.where('date', '<=', filter.toDate);
    }
    const manualJournals = await query;
    const inRange = manualJournals.filter((manualJournal) => {
      const amount = Math.abs(
        bankAccountNet(manualJournal, accountCurrencyCode),
      );
      if (amount === 0) return false;
      if (filter.minAmount && amount < filter.minAmount) return false;
      if (filter.maxAmount && amount > filter.maxAmount) return false;
      return true;
    });
    return this.transformer.transform(
      inRange,
      new GetMatchedTransactionManualJournalsTransformer(),
      { accountCurrencyCode },
    );
  }

  /**
   * Retrieves the manual journal to match, with its lines on the bank
   * account (its amount). Not found when it has no line on that account.
   * @param {number} transactionId
   * @param {MatchedTransactionContext} context - The bank line's account.
   */
  public async getMatchedTransaction(
    transactionId: number,
    context?: MatchedTransactionContext,
  ) {
    const accountId = context?.accountId;
    const accountCurrencyCode = context?.accountCurrencyCode;
    const manualJournal = await this.manualJournalModel()
      .query()
      .findById(transactionId)
      .modify('filterByPublished')
      .whereNotExists(ManualJournal.relatedQuery('matchedBankTransaction'))
      .withGraphFetched('entries')
      .modifyGraph('entries', (builder) => {
        builder.where('accountId', accountId ?? null);
      })
      .throwIfNotFound();

    if (
      !accountId ||
      bankAccountNet(manualJournal, accountCurrencyCode) === 0
    ) {
      return null;
    }
    return this.transformer.transform(
      manualJournal,
      new GetMatchedTransactionManualJournalsTransformer(),
      { accountCurrencyCode },
    );
  }
}
