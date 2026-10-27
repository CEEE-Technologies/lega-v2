import { events } from '@/common/events/events';
import { RefundCreditNoteGLEntries } from '@/modules/CreditNoteRefunds/commands/RefundCreditNoteGLEntries';
import {
  IRefundCreditNoteCreatedPayload,
  IRefundCreditNoteDeletedPayload,
} from '@/modules/CreditNoteRefunds/types/CreditNoteRefunds.types';
import {
  ICreditNoteEditedPayload,
  ICreditNoteEditingPayload,
} from '@/modules/CreditNotes/types/CreditNotes.types';
import { LinkedTransactionsLockingGuard } from '@/modules/TransactionsLocking/guards/LinkedTransactionsLockingGuard';
import { TransactionsLockingGroup } from '@/modules/TransactionsLocking/types/TransactionsLocking.types';
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

@Injectable()
export class RefundCreditNoteGLEntriesSubscriber {
  constructor(
    private readonly refundCreditGLEntries: RefundCreditNoteGLEntries,
    private readonly linkedTransactionsLockingGuard: LinkedTransactionsLockingGuard,
  ) {}

  /**
   * Blocks the credit note edit before anything is saved when it would
   * rewrite a refund dated inside a locked period.
   * @param {ICreditNoteEditingPayload} payload -
   */
  @OnEvent(events.creditNote.onEditing, { suppressErrors: false })
  async validateLinkedRefundsNotLocked({
    oldCreditNote,
    trx,
  }: ICreditNoteEditingPayload) {
    const refunds = await this.refundCreditGLEntries.getCreditNoteRefunds(
      oldCreditNote.id,
      trx,
    );
    await this.linkedTransactionsLockingGuard.validateLinkedTransactionsNotLocked(
      refunds,
      TransactionsLockingGroup.Sales,
      'this credit note',
    );
  }

  /**
   * Writes refund credit note GL entries once the transaction created.
   * @param {IRefundCreditNoteCreatedPayload} payload -
   */
  @OnEvent(events.creditNote.onRefundCreated)
  async writeRefundCreditGLEntriesOnceCreated({
    trx,
    refundCreditNote,
    creditNote: _creditNote,
  }: IRefundCreditNoteCreatedPayload) {
    await this.refundCreditGLEntries.createRefundCreditGLEntries(
      refundCreditNote.id,
      trx,
    );
  }

  /**
   * Reverts refund credit note GL entries once the transaction deleted.
   * @param {IRefundCreditNoteDeletedPayload} payload -
   */
  @OnEvent(events.creditNote.onRefundDeleted)
  async revertRefundCreditGLEntriesOnceDeleted({
    trx,
    refundCreditId,
    oldRefundCredit: _oldRefundCredit,
  }: IRefundCreditNoteDeletedPayload) {
    await this.refundCreditGLEntries.revertRefundCreditGLEntries(
      refundCreditId,
      trx,
    );
  }

  /**
   * Rewrites the refunds cash basis entries once the credit note is edited,
   * so they follow the edited credit note composition.
   * @param {ICreditNoteEditedPayload} payload -
   */
  @OnEvent(events.creditNote.onEdited)
  async rewriteRefundsCashGLEntriesOnceCreditNoteEdited({
    creditNote,
    oldCreditNote,
    trx,
  }: ICreditNoteEditedPayload) {
    await this.refundCreditGLEntries.rewriteCreditNoteRefundsCashGLEntries(
      creditNote?.id ?? oldCreditNote.id,
      trx,
    );
  }
}
