import { Injectable } from '@nestjs/common';
import * as moment from 'moment';
import {
  IPaymentReceivedCreatedPayload,
  IPaymentReceivedDeletedPayload,
  IPaymentReceivedEditedPayload,
} from '../types/PaymentReceived.types';
import { PaymentReceivedGLEntries } from '../commands/PaymentReceivedGLEntries';
import { OnEvent } from '@nestjs/event-emitter';
import { events } from '@/common/events/events';

/**
 * The invoices paid by the given payment entries.
 */
const invoicesIdsOf = (...entriesLists: Array<any[] | undefined>) =>
  entriesLists
    .flatMap((entries) => entries || [])
    .map((entry) => entry.invoiceId)
    .filter(Boolean);

/**
 * The earlier of two payment dates.
 */
const earlierDate = (a: any, b: any) => (moment(a).isBefore(moment(b)) ? a : b);

@Injectable()
export class PaymentReceivedGLEntriesSubscriber {
  constructor(
    private readonly paymentReceivedGLEntries: PaymentReceivedGLEntries,
  ) {}

  /**
   * Handle journal entries writing once the payment receive created.
   * The later payments of the same invoices are rebuilt in order, since
   * their cash basis split starts from what was paid before them (a
   * back-dated payment changes it).
   */
  @OnEvent(events.paymentReceive.onCreated)
  private async handleWriteJournalEntriesOnceCreated({
    paymentReceiveId,
    paymentReceive,
    paymentReceiveDTO,
    trx,
  }: IPaymentReceivedCreatedPayload) {
    await this.paymentReceivedGLEntries.writePaymentGLEntries(
      paymentReceiveId,
      trx,
    );
    await this.paymentReceivedGLEntries.rewriteLaterPaymentsCashGLEntries(
      invoicesIdsOf(paymentReceive?.entries, paymentReceiveDTO?.entries),
      {
        id: paymentReceiveId,
        date: paymentReceive?.paymentDate ?? paymentReceiveDTO?.paymentDate,
      },
      trx,
    );
  }

  /**
   * Handle journal entries writing once the payment receive edited, then
   * rebuilds the later payments of the old and new invoices in order (from
   * the earlier of the old and new dates).
   */
  @OnEvent(events.paymentReceive.onEdited)
  private async handleOverwriteJournalEntriesOnceEdited({
    paymentReceive,
    oldPaymentReceive,
    trx,
  }: IPaymentReceivedEditedPayload) {
    await this.paymentReceivedGLEntries.rewritePaymentGLEntries(
      paymentReceive.id,
      trx,
    );
    await this.paymentReceivedGLEntries.rewriteLaterPaymentsCashGLEntries(
      invoicesIdsOf(paymentReceive?.entries, oldPaymentReceive?.entries),
      {
        id: paymentReceive.id,
        date: earlierDate(
          paymentReceive.paymentDate,
          oldPaymentReceive?.paymentDate ?? paymentReceive.paymentDate,
        ),
      },
      trx,
    );
  }

  /**
   * Handles revert journal entries once deleted, then rebuilds the later
   * payments of its invoices in order.
   */
  @OnEvent(events.paymentReceive.onDeleted)
  private async handleRevertJournalEntriesOnceDeleted({
    paymentReceiveId,
    oldPaymentReceive,
    trx,
  }: IPaymentReceivedDeletedPayload) {
    await this.paymentReceivedGLEntries.revertPaymentGLEntries(
      paymentReceiveId,
      trx,
    );
    if (oldPaymentReceive) {
      await this.paymentReceivedGLEntries.rewriteLaterPaymentsCashGLEntries(
        invoicesIdsOf(oldPaymentReceive.entries),
        { id: paymentReceiveId, date: oldPaymentReceive.paymentDate },
        trx,
      );
    }
  }
}
