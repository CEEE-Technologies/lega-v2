import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { events } from '@/common/events/events';
import { ISaleInvoiceEditingPayload } from '../SaleInvoice.types';
import { InvoicePaymentsGLEntriesRewrite } from '../InvoicePaymentsGLRewrite';
import { LinkedTransactionsLockingGuard } from '@/modules/TransactionsLocking/guards/LinkedTransactionsLockingGuard';
import { TransactionsLockingGroup } from '@/modules/TransactionsLocking/types/TransactionsLocking.types';

@Injectable()
export class InvoicePaymentGLRewriteSubscriber {
  constructor(
    private readonly invoicePaymentsRewriteGLEntries: InvoicePaymentsGLEntriesRewrite,
    private readonly linkedTransactionsLockingGuard: LinkedTransactionsLockingGuard,
  ) {}

  /**
   * Blocks the invoice edit before anything is saved when it would rewrite
   * a payment dated inside a locked period.
   * @param {ISaleInvoiceEditingPayload} payload -
   */
  @OnEvent(events.saleInvoice.onEditing, { suppressErrors: false })
  async validateLinkedPaymentsNotLocked({
    oldSaleInvoice,
    trx,
  }: ISaleInvoiceEditingPayload) {
    const payments =
      await this.invoicePaymentsRewriteGLEntries.getInvoiceLinkedPayments(
        oldSaleInvoice.id,
        trx,
      );
    await this.linkedTransactionsLockingGuard.validateLinkedTransactionsNotLocked(
      payments,
      TransactionsLockingGroup.Sales,
      'this invoice',
    );
  }

  /**
   * Writes associated invoiceso of payment receive once edit.
   * @param {ISaleInvoiceEditingPayload} -
   */
  @OnEvent(events.saleInvoice.onEdited)
  async paymentGLEntriesRewriteOnPaymentEdit({
    oldSaleInvoice,
    trx,
  }: ISaleInvoiceEditingPayload) {
    await this.invoicePaymentsRewriteGLEntries.invoicePaymentsGLEntriesRewrite(
      oldSaleInvoice.id,
      trx,
    );
  }
}
