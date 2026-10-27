import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { events } from '@/common/events/events';
import {
  IBillEditedPayload,
  IBillEditingPayload,
} from '@/modules/Bills/Bills.types';
import { LinkedTransactionsLockingGuard } from '@/modules/TransactionsLocking/guards/LinkedTransactionsLockingGuard';
import { TransactionsLockingGroup } from '@/modules/TransactionsLocking/types/TransactionsLocking.types';
import { BillPaymentsGLEntriesRewrite } from '../commands/BillPaymentsGLRewrite';

@Injectable()
export class BillPaymentGLRewriteSubscriber {
  constructor(
    private readonly billPaymentsGLEntriesRewrite: BillPaymentsGLEntriesRewrite,
    private readonly linkedTransactionsLockingGuard: LinkedTransactionsLockingGuard,
  ) {}

  /**
   * Blocks the bill edit before anything is saved when it would rewrite a
   * payment dated inside a locked period.
   * @param {IBillEditingPayload} payload -
   */
  @OnEvent(events.bill.onEditing, { suppressErrors: false })
  async validateLinkedPaymentsNotLocked({ oldBill, trx }: IBillEditingPayload) {
    const payments =
      await this.billPaymentsGLEntriesRewrite.getBillLinkedPayments(
        oldBill.id,
        trx,
      );
    await this.linkedTransactionsLockingGuard.validateLinkedTransactionsNotLocked(
      payments,
      TransactionsLockingGroup.Purchases,
      'this bill',
    );
  }

  /**
   * Rewrites the GL entries of the bill payments once the bill is edited.
   * @param {IBillEditedPayload} payload -
   */
  @OnEvent(events.bill.onEdited)
  async paymentGLEntriesRewriteOnBillEdited({
    oldBill,
    trx,
  }: IBillEditedPayload) {
    await this.billPaymentsGLEntriesRewrite.rewriteBillPaymentsGLEntries(
      oldBill.id,
      trx,
    );
  }
}
