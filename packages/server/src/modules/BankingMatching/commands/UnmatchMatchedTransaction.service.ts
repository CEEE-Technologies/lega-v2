import { Inject, Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { uniq, uniqBy } from 'lodash';
import { IBankTransactionUnmatchingEventPayload } from '../types';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { UnitOfWork } from '../../Tenancy/TenancyDB/UnitOfWork.service';
import { events } from '@/common/events/events';
import { MatchedBankTransaction } from '../models/MatchedBankTransaction';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { UncategorizedBankTransaction } from '@/modules/BankingTransactions/models/UncategorizedBankTransaction';
import { DeletePaymentReceivedService } from '@/modules/PaymentReceived/commands/DeletePaymentReceived.service';
import { DeleteBillPayment } from '@/modules/BillPayments/commands/DeleteBillPayment.service';

/**
 * Matching a bank line to an invoice or a bill creates a payment for it and
 * links the line to that payment with these types. Nothing else creates
 * them: a line can't be matched to an existing payment.
 */
export const PAYMENT_TYPES_CREATED_BY_MATCH = ['PaymentReceive', 'BillPayment'];

/** The table of each payment type a match creates. */
const CREATED_PAYMENT_TABLES: Record<string, string> = {
  PaymentReceive: 'payment_receives',
  BillPayment: 'bills_payments',
};

@Injectable()
export class UnmatchMatchedBankTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly eventPublisher: EventEmitter2,
    private readonly deletePaymentReceivedService: DeletePaymentReceivedService,
    private readonly deleteBillPaymentService: DeleteBillPayment,

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
   * The payment the match created is deleted with it (D3): otherwise it
   * would keep counting, and using the line again would count the money
   * twice. Documents that existed before the match are only unlinked.
   * @param {number} uncategorizedTransactionId - Uncategorized transaction id.
   * @returns {Promise<void>}
   */
  public unmatchMatchedTransaction(
    uncategorizedTransactionId: number,
  ): Promise<void> {
    return this.uow.withTransaction(async (trx) => {
      // An unknown bank line is "not found", not a crash in a handler.
      // Locked, so two unmatches of the same line don't both delete.
      await this.uncategorizedBankTransactionModel()
        .query(trx)
        .findById(uncategorizedTransactionId)
        .forUpdate()
        .throwIfNotFound();

      await this.eventPublisher.emitAsync(events.bankMatch.onUnmatching, {
        uncategorizedTransactionId,
        trx,
      } as IBankTransactionUnmatchingEventPayload);

      const matches = await this.matchedBankTransactionModel()
        .query(trx)
        .where('uncategorizedTransactionId', uncategorizedTransactionId);

      // Nothing was matched, so there is nothing to undo: the account's
      // uncategorized counter must not go up.
      if (matches.length === 0) return;

      const createdPayments = uniqBy(
        matches.filter((match) =>
          PAYMENT_TYPES_CREATED_BY_MATCH.includes(match.referenceType),
        ),
        (match) => `${match.referenceType}-${match.referenceId}`,
      );
      // Lines matched together (one match of several lines) share the
      // payment it created. The payment goes, so they are unmatched too.
      const linesIds = await this.getLinesSharingPayments(
        uncategorizedTransactionId,
        createdPayments,
        trx,
      );
      // Unlink first: the payment can't be deleted while it is matched.
      await this.matchedBankTransactionModel()
        .query(trx)
        .whereIn('uncategorizedTransactionId', linesIds)
        .delete();

      for (const payment of createdPayments) {
        await this.deleteCreatedPayment(payment, trx);
      }
      for (const lineId of linesIds) {
        await this.eventPublisher.emitAsync(events.bankMatch.onUnmatched, {
          uncategorizedTransactionId: lineId,
          trx,
        } as IBankTransactionUnmatchingEventPayload);
      }
    });
  }

  /**
   * Retrieves the given line and every other line linked to one of the
   * given payments.
   */
  private async getLinesSharingPayments(
    uncategorizedTransactionId: number,
    payments: MatchedBankTransaction[],
    trx: Knex.Transaction,
  ): Promise<number[]> {
    if (payments.length === 0) return [uncategorizedTransactionId];

    const shared = await this.matchedBankTransactionModel()
      .query(trx)
      .where((query) => {
        payments.forEach((payment) => {
          query.orWhere({
            referenceType: payment.referenceType,
            referenceId: payment.referenceId,
          });
        });
      });
    return uniq([
      uncategorizedTransactionId,
      ...shared.map((match) => match.uncategorizedTransactionId),
    ]);
  }

  /**
   * Deletes a payment the match created, with its ledger entries, and
   * puts the paid amount back on the invoice or bill. A payment that is
   * already gone (deleted while the line was still matched) is skipped, so
   * the line can still be unmatched.
   */
  private async deleteCreatedPayment(
    payment: MatchedBankTransaction,
    trx: Knex.Transaction,
  ) {
    const table = CREATED_PAYMENT_TABLES[payment.referenceType];
    if (!table) return;

    const exists = await trx(table)
      .where('id', payment.referenceId)
      .first('id');
    if (!exists) return;

    if (payment.referenceType === 'PaymentReceive') {
      await this.deletePaymentReceivedService.deletePaymentReceive(
        payment.referenceId,
        trx,
      );
    } else if (payment.referenceType === 'BillPayment') {
      await this.deleteBillPaymentService.deleteBillPayment(
        payment.referenceId,
        trx,
      );
    }
  }
}
