import { Inject, Injectable } from '@nestjs/common';
import { IBankTransactionUnmatchingEventPayload } from '../types';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { UnitOfWork } from '../../Tenancy/TenancyDB/UnitOfWork.service';
import { events } from '@/common/events/events';
import { MatchedBankTransaction } from '../models/MatchedBankTransaction';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { UncategorizedBankTransaction } from '@/modules/BankingTransactions/models/UncategorizedBankTransaction';

@Injectable()
export class UnmatchMatchedBankTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly eventPublisher: EventEmitter2,

    @Inject(MatchedBankTransaction.name)
    private readonly matchedBankTransactionModel: TenantModelProxy<
      typeof MatchedBankTransaction
    >,

    @Inject(UncategorizedBankTransaction.name)
    private readonly uncategorizedBankTransactionModel: TenantModelProxy<
      typeof UncategorizedBankTransaction
    >,
  ) {}

  /**
   * Unmatch the matched the given uncategorized bank transaction.
   * @param {number} uncategorizedTransactionId - Uncategorized transaction id.
   * @returns {Promise<void>}
   */
  public unmatchMatchedTransaction(
    uncategorizedTransactionId: number,
  ): Promise<void> {
    return this.uow.withTransaction(async (trx) => {
      // An unknown bank line is "not found", not a crash in a handler.
      await this.uncategorizedBankTransactionModel()
        .query(trx)
        .findById(uncategorizedTransactionId)
        .throwIfNotFound();

      await this.eventPublisher.emitAsync(events.bankMatch.onUnmatching, {
        uncategorizedTransactionId,
        trx,
      } as IBankTransactionUnmatchingEventPayload);

      const deletedMatches = await this.matchedBankTransactionModel()
        .query(trx)
        .where('uncategorizedTransactionId', uncategorizedTransactionId)
        .delete();

      // Nothing was matched, so there is nothing to undo: the account's
      // uncategorized counter must not go up.
      if (!deletedMatches) return;

      await this.eventPublisher.emitAsync(events.bankMatch.onUnmatched, {
        uncategorizedTransactionId,
        trx,
      } as IBankTransactionUnmatchingEventPayload);
    });
  }
}
