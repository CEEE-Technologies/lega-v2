import { Inject, Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { events } from '@/common/events/events';
import {
  IBillPaymentEventCreatedPayload,
  IBillPaymentEventDeletedPayload,
  IBillPaymentEventEditedPayload,
} from '../types/BillPayments.types';
import { IVendorOpeningBalanceEditedPayload } from '@/modules/Vendors/types/Vendors.types';
import { ContactOpeningBalancePayment } from '@/modules/Contacts/ContactOpeningBalancePayment.service';
import { PaymentEntryTypes } from '@/modules/Contacts/ContactOpeningBalance.constants';
import { BillPaymentGLEntries } from '../commands/BillPaymentGLEntries';
import { BillPayment } from '../models/BillPayment';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';

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
   * balance, since they post to the opening balance account.
   */
  @OnEvent(events.vendors.onOpeningBalanceChanged)
  async handleOpeningBalanceChanged({
    vendor,
    trx,
  }: IVendorOpeningBalanceEditedPayload) {
    const payments = await this.billPaymentModel()
      .query(trx)
      .where('vendor_id', vendor.id)
      .whereIn('id', (builder) =>
        builder
          .select('bill_payment_id')
          .from('bills_payments_entries')
          .where('entry_type', PaymentEntryTypes.OpeningBalance),
      )
      .select('id');

    for (const payment of payments) {
      await this.billPaymentGLEntries.rewritePaymentCashGLEntries(
        payment.id,
        trx,
      );
    }
  }
}
