import { events } from '@/common/events/events';
import { RefundVendorCreditGLEntries } from '../commands/RefundVendorCreditGLEntries';
import {
  IRefundVendorCreditCreatedPayload,
  IRefundVendorCreditDeletedPayload,
} from '../types/VendorCreditRefund.types';
import {
  IVendorCreditEditedPayload,
  IVendorCreditEditingPayload,
} from '@/modules/VendorCredit/types/VendorCredit.types';
import { LinkedTransactionsLockingGuard } from '@/modules/TransactionsLocking/guards/LinkedTransactionsLockingGuard';
import { TransactionsLockingGroup } from '@/modules/TransactionsLocking/types/TransactionsLocking.types';
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

@Injectable()
export class RefundVendorCreditGLEntriesSubscriber {
  constructor(
    private readonly refundVendorCreditGLEntries: RefundVendorCreditGLEntries,
    private readonly linkedTransactionsLockingGuard: LinkedTransactionsLockingGuard,
  ) {}

  /**
   * Blocks the vendor credit edit before anything is saved when it would
   * rewrite a refund dated inside a locked period.
   * @param {IVendorCreditEditingPayload} payload -
   */
  @OnEvent(events.vendorCredit.onEditing, { suppressErrors: false })
  async validateLinkedRefundsNotLocked({
    oldVendorCredit,
    trx,
  }: IVendorCreditEditingPayload) {
    const refunds =
      await this.refundVendorCreditGLEntries.getVendorCreditRefunds(
        oldVendorCredit.id,
        trx,
      );
    await this.linkedTransactionsLockingGuard.validateLinkedTransactionsNotLocked(
      refunds,
      TransactionsLockingGroup.Purchases,
      'this vendor credit',
    );
  }

  /**
   * Writes refund vendor credit GL entries once the transaction created.
   * @param {IRefundVendorCreditCreatedPayload} payload -
   */
  @OnEvent(events.vendorCredit.onRefundCreated)
  async writeRefundVendorCreditGLEntriesOnceCreated({
    trx,
    refundVendorCredit,
    vendorCredit: _vendorCredit,
  }: IRefundVendorCreditCreatedPayload) {
    await this.refundVendorCreditGLEntries.createRefundVendorCreditGLEntries(
      refundVendorCredit.id,
      trx,
    );
    // A back-dated refund changes the split of the later refunds.
    await this.refundVendorCreditGLEntries.rewriteLaterRefundsCashGLEntries(
      refundVendorCredit.vendorCreditId,
      { id: refundVendorCredit.id, date: refundVendorCredit.date },
      trx,
    );
  }

  /**
   * Reverts refund vendor credit GL entries once the transaction deleted.
   * @param {IRefundVendorCreditDeletedPayload} payload -
   */
  @OnEvent(events.vendorCredit.onRefundDeleted)
  async revertRefundVendorCreditGLEntriesOnceDeleted({
    trx,
    refundCreditId,
    oldRefundCredit,
  }: IRefundVendorCreditDeletedPayload) {
    await this.refundVendorCreditGLEntries.revertRefundVendorCreditGLEntries(
      refundCreditId,
      trx,
    );
    // The later refunds of the vendor credit are rebuilt in order.
    if (oldRefundCredit?.vendorCreditId) {
      await this.refundVendorCreditGLEntries.rewriteLaterRefundsCashGLEntries(
        oldRefundCredit.vendorCreditId,
        { id: refundCreditId, date: oldRefundCredit.date },
        trx,
      );
    }
  }

  /**
   * Rewrites the refunds cash basis entries once the vendor credit is edited,
   * so they follow the edited vendor credit composition.
   * @param {IVendorCreditEditedPayload} payload -
   */
  @OnEvent(events.vendorCredit.onEdited)
  async rewriteRefundsCashGLEntriesOnceVendorCreditEdited({
    vendorCredit,
    oldVendorCredit,
    trx,
  }: IVendorCreditEditedPayload) {
    await this.refundVendorCreditGLEntries.rewriteVendorCreditRefundsCashGLEntries(
      vendorCredit?.id ?? oldVendorCredit.id,
      trx,
    );
  }
}
