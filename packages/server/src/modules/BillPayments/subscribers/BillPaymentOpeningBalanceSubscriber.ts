import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { events } from '@/common/events/events';
import {
  IBillPaymentEventCreatedPayload,
  IBillPaymentEventDeletedPayload,
  IBillPaymentEventEditedPayload,
} from '../types/BillPayments.types';
import {
  IVendorOpeningBalanceEditedPayload,
  IVendorOpeningBalanceEditingPayload,
} from '@/modules/Vendors/types/Vendors.types';
import { ContactOpeningBalancePayment } from '@/modules/Contacts/ContactOpeningBalancePayment.service';
import { PaymentEntryTypes } from '@/modules/Contacts/ContactOpeningBalance.constants';
import { BillPaymentGLEntries } from '../commands/BillPaymentGLEntries';
import { BillPayment } from '../models/BillPayment';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { LinkedTransactionsLockingGuard } from '@/modules/TransactionsLocking/guards/LinkedTransactionsLockingGuard';
import { TransactionsLockingGroup } from '@/modules/TransactionsLocking/types/TransactionsLocking.types';

/**
 * Keeps the vendor's paid opening balance in sync with the payment lines
 * that pay it, and rewrites those payments' cash entries when the opening
 * balance itself is edited.
 */
@Injectable()
export class BillPaymentOpeningBalanceSubscriber {
  constructor(
    private readonly openingBalancePayment: ContactOpeningBalancePayment,
    private readonly billPaymentGLEntries: BillPaymentGLEntries,
    private readonly linkedTransactionsLockingGuard: LinkedTransactionsLockingGuard,

    @Inject(BillPayment.name)
    private readonly billPaymentModel: TenantModelProxy<typeof BillPayment>,
  ) {}

  @OnEvent(events.billPayment.onCreated)
  async handlePaymentCreated({
    billPayment,
    trx,
  }: IBillPaymentEventCreatedPayload) {
    await this.openingBalancePayment.syncPaidAmount(
      { contactId: billPayment.vendorId, entries: billPayment.entries },
      null,
      trx,
    );
  }

  @OnEvent(events.billPayment.onEdited)
  async handlePaymentEdited({
    billPayment,
    oldBillPayment,
    trx,
  }: IBillPaymentEventEditedPayload) {
    await this.openingBalancePayment.syncPaidAmount(
      { contactId: billPayment.vendorId, entries: billPayment.entries },
      { contactId: oldBillPayment.vendorId, entries: oldBillPayment.entries },
      trx,
    );
  }

  @OnEvent(events.billPayment.onDeleted)
  async handlePaymentDeleted({
    oldBillPayment,
    trx,
  }: IBillPaymentEventDeletedPayload) {
    await this.openingBalancePayment.syncPaidAmount(
      null,
      { contactId: oldBillPayment.vendorId, entries: oldBillPayment.entries },
      trx,
    );
  }

  /**
   * Rewrites the cash entries of the vendor payments that pay the opening
   * balance, since they post to the opening balance account. With a foreign
   * opening balance their accrual entries too: they relieve A/P at the
   * opening balance rate, which may have changed.
   */
  @OnEvent(events.vendors.onOpeningBalanceChanged)
  async handleOpeningBalanceChanged({
    vendor,
    oldVendor,
    trx,
  }: IVendorOpeningBalanceEditedPayload) {
    const payments = await this.getOpeningBalancePayments(vendor.id, trx);
    const isForeign = [vendor, oldVendor].some(
      (contact) => Number(contact?.openingBalanceExchangeRate ?? 1) !== 1,
    );
    for (const payment of payments) {
      await (isForeign
        ? this.billPaymentGLEntries.rewritePaymentGLEntries(payment.id, trx)
        : this.billPaymentGLEntries.rewritePaymentCashGLEntries(
            payment.id,
            trx,
          ));
    }
  }

  /**
   * Blocks the opening balance edit before anything is saved when it would
   * rewrite a payment (of the opening balance) dated in a locked period.
   */
  @OnEvent(events.vendors.onOpeningBalanceChanging, { suppressErrors: false })
  async validateOpeningBalancePaymentsNotLocked({
    oldVendor,
    trx,
  }: IVendorOpeningBalanceEditingPayload) {
    const payments = await this.getOpeningBalancePayments(oldVendor.id, trx);

    await this.linkedTransactionsLockingGuard.validateLinkedTransactionsNotLocked(
      payments.map((payment) => ({
        label: `Payment ${payment.paymentNumber || `#${payment.id}`}`,
        date: payment.paymentDate,
      })),
      TransactionsLockingGroup.Purchases,
      'this opening balance',
    );
  }

  /**
   * Retrieves the payments that pay the given contact's opening balance.
   */
  private getOpeningBalancePayments(contactId: number, trx?: Knex.Transaction) {
    return this.billPaymentModel()
      .query(trx)
      .where('vendor_id', contactId)
      .whereIn('id', (builder) =>
        builder
          .select('bill_payment_id')
          .from('bills_payments_entries')
          .where('entry_type', PaymentEntryTypes.OpeningBalance),
      )
      .select('id', 'paymentNumber', 'paymentDate');
  }
}
