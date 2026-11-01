import { Injectable } from '@nestjs/common';
import {
  ICreditNoteCreatedPayload,
  ICreditNoteDeletedPayload,
  ICreditNoteEditedPayload,
} from '../types/CreditNotes.types';
import { OnEvent } from '@nestjs/event-emitter';
import { events } from '@/common/events/events';
import { CreditNoteInventoryTransactions } from '../commands/CreditNotesInventoryTransactions';

@Injectable()
export class CreditNoteInventoryTransactionsSubscriber {
  constructor(
    private readonly inventoryTransactions: CreditNoteInventoryTransactions,
  ) {}

  /**
   * Writes inventory transactions once credit note created.
   * @param {ICreditNoteCreatedPayload} payload -
   * @returns {Promise<void>}
   */
  @OnEvent(events.creditNote.onCreated)
  @OnEvent(events.creditNote.onOpened)
  public async writeInventoryTranscationsOnceCreated({
    creditNote,
    trx,
  }: ICreditNoteCreatedPayload) {
    // A draft moves no stock. (`isOpen` also needs credit left to apply,
    // which says nothing about the returned goods.)
    if (!creditNote.isPublished) return;

    await this.inventoryTransactions.createInventoryTransactions(
      creditNote,
      trx,
    );
  }

  /**
   * Rewrites inventory transactions once credit note edited.
   * @param {ICreditNoteEditedPayload} payload -
   * @returns {Promise<void>}
   */
  @OnEvent(events.creditNote.onEdited)
  public async rewriteInventoryTransactionsOnceEdited({
    creditNote,
    oldCreditNote,
    trx,
  }: ICreditNoteEditedPayload) {
    // The edited credit note is re-read: the saved graph has only the
    // edited fields (no `openedAt`), so it always looked like a draft and
    // an edit never moved stock.
    await this.inventoryTransactions.rewriteInventoryTransactions(
      creditNote?.id ?? oldCreditNote.id,
      trx,
    );
  }

  /**
   * Reverts inventory transactions once credit note deleted.
   * @param {ICreditNoteDeletedPayload} payload -
   */
  @OnEvent(events.creditNote.onDeleted)
  public async revertInventoryTransactionsOnceDeleted({
    oldCreditNote,
    trx,
  }: ICreditNoteDeletedPayload) {
    // Undoes the stock movement of any published credit note.
    if (!oldCreditNote.isPublished) return;

    await this.inventoryTransactions.deleteInventoryTransactions(
      oldCreditNote.id,
      trx,
    );
  }
}
