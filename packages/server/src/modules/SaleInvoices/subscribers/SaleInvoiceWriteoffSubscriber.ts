import { Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ISaleInvoiceWriteoffCreatePayload,
  ISaleInvoiceWrittenOffCanceledPayload,
} from '../SaleInvoice.types';
import { SaleInvoiceWriteoffGLStorage } from '../commands/writeoff/SaleInvoiceWriteoffGLStorage';
import { events } from '@/common/events/events';

@Injectable()
export class SaleInvoiceWriteoffSubscriber {
  constructor(private readonly writeGLStorage: SaleInvoiceWriteoffGLStorage) {}

  /**
   * Write the written-off sale invoice journal entries.
   * @param {ISaleInvoiceWriteoffCreatePayload}
   */
  @OnEvent(events.saleInvoice.onWrittenoff)
  public async writeJournalEntriesOnceWriteoffCreate({
    saleInvoice,
    trx,
  }: ISaleInvoiceWriteoffCreatePayload) {
    await this.writeGLStorage.writeInvoiceWriteoffEntries(saleInvoice.id, trx);
  }

  /**
   * Reverts the written-of sale invoice jounral entries.
   * @param {ISaleInvoiceWrittenOffCanceledPayload}
   */
  @OnEvent(events.saleInvoice.onWrittenoffCanceled)
  public async revertJournalEntriesOnce({
    saleInvoice,
    trx,
  }: ISaleInvoiceWrittenOffCanceledPayload) {
    await this.writeGLStorage.revertInvoiceWriteoffEntries(saleInvoice.id, trx);
  }

  /**
   * A write-off is what the payments and applied credits leave: when they
   * change on a written-off invoice, the write-off is rebuilt so its A/R
   * still ends at 0.
   */
  @OnEvent(events.paymentReceive.onCreated)
  @OnEvent(events.paymentReceive.onEdited)
  @OnEvent(events.paymentReceive.onDeleted)
  public async rewriteOnPaymentChange({
    paymentReceive,
    oldPaymentReceive,
    trx,
  }: {
    paymentReceive?: { entries?: { invoiceId?: number }[] };
    oldPaymentReceive?: { entries?: { invoiceId?: number }[] };
    trx?: Knex.Transaction;
  }) {
    await this.writeGLStorage.rewriteWrittenoffInvoicesEntries(
      [
        ...(paymentReceive?.entries || []),
        ...(oldPaymentReceive?.entries || []),
      ]
        .map((entry) => entry.invoiceId)
        .filter(Boolean),
      trx,
    );
  }

  @OnEvent(events.creditNote.onApplyToInvoicesCreated)
  public async rewriteOnCreditApplied({
    creditNoteAppliedInvoices,
    trx,
  }: {
    creditNoteAppliedInvoices?: { invoiceId: number }[];
    trx?: Knex.Transaction;
  }) {
    await this.writeGLStorage.rewriteWrittenoffInvoicesEntries(
      (creditNoteAppliedInvoices || []).map((entry) => entry.invoiceId),
      trx,
    );
  }

  @OnEvent(events.creditNote.onApplyToInvoicesDeleted)
  public async rewriteOnCreditUnapplied({
    creditNoteAppliedToInvoice,
    trx,
  }: {
    creditNoteAppliedToInvoice?: { invoiceId: number };
    trx?: Knex.Transaction;
  }) {
    await this.writeGLStorage.rewriteWrittenoffInvoicesEntries(
      [creditNoteAppliedToInvoice?.invoiceId],
      trx,
    );
  }
}
