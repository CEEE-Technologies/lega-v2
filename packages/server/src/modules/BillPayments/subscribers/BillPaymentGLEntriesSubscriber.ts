import * as moment from 'moment';
import {
  IBillPaymentEventCreatedPayload,
  IBillPaymentEventDeletedPayload,
  IBillPaymentEventEditedPayload,
} from '../types/BillPayments.types';
import { BillPaymentGLEntries } from '../commands/BillPaymentGLEntries';
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { events } from '@/common/events/events';

/**
 * The bills paid by the given payment entries.
 */
const billsIdsOf = (...entriesLists: Array<any[] | undefined>) =>
  entriesLists
    .flatMap((entries) => entries || [])
    .map((entry) => entry.billId)
    .filter(Boolean);

/**
 * The earlier of two payment dates.
 */
const earlierDate = (a: any, b: any) => (moment(a).isBefore(moment(b)) ? a : b);

@Injectable()
export class BillPaymentGLEntriesSubscriber {
  constructor(private readonly billPaymentGLEntries: BillPaymentGLEntries) {}

  /**
   * Handle bill payment writing journal entries once created. The later
   * payments of the same bills are rebuilt in order, since their cash basis
   * split starts from what was paid before them.
   */
  @OnEvent(events.billPayment.onCreated)
  async handleWriteJournalEntries({
    billPayment,
    billPaymentDTO,
    trx,
  }: IBillPaymentEventCreatedPayload) {
    // Records the journal transactions after bills payment
    // and change diff account balance.
    await this.billPaymentGLEntries.writePaymentGLEntries(billPayment.id, trx);
    await this.billPaymentGLEntries.rewriteLaterPaymentsCashGLEntries(
      billsIdsOf(billPayment?.entries, billPaymentDTO?.entries),
      {
        id: billPayment.id,
        date: billPayment.paymentDate ?? billPaymentDTO?.paymentDate,
      },
      trx,
    );
  }

  /**
   * Handle bill payment re-writing journal entries once the payment
   * transaction be edited, then rebuilds the later payments of the old and
   * new bills in order.
   */
  @OnEvent(events.billPayment.onEdited)
  async handleRewriteJournalEntriesOncePaymentEdited({
    billPayment,
    oldBillPayment,
    trx,
  }: IBillPaymentEventEditedPayload) {
    await this.billPaymentGLEntries.rewritePaymentGLEntries(
      billPayment.id,
      trx,
    );
    await this.billPaymentGLEntries.rewriteLaterPaymentsCashGLEntries(
      billsIdsOf(billPayment?.entries, oldBillPayment?.entries),
      {
        id: billPayment.id,
        date: earlierDate(
          billPayment.paymentDate,
          oldBillPayment?.paymentDate ?? billPayment.paymentDate,
        ),
      },
      trx,
    );
  }

  /**
   * Reverts journal entries once bill payment deleted, then rebuilds the
   * later payments of its bills in order.
   */
  @OnEvent(events.billPayment.onDeleted)
  async handleRevertJournalEntries({
    billPaymentId,
    oldBillPayment,
    trx,
  }: IBillPaymentEventDeletedPayload) {
    await this.billPaymentGLEntries.revertPaymentGLEntries(billPaymentId, trx);

    if (oldBillPayment) {
      await this.billPaymentGLEntries.rewriteLaterPaymentsCashGLEntries(
        billsIdsOf(oldBillPayment.entries),
        { id: billPaymentId, date: oldBillPayment.paymentDate },
        trx,
      );
    }
  }
}
