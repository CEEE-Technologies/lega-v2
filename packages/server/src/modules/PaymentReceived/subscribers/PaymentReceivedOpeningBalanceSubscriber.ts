import { Inject, Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { events } from '@/common/events/events';
import {
  IPaymentReceivedCreatedPayload,
  IPaymentReceivedDeletedPayload,
  IPaymentReceivedEditedPayload,
} from '../types/PaymentReceived.types';
import { ICustomerOpeningBalanceEditedPayload } from '@/modules/Customers/types/Customers.types';
import { ContactOpeningBalancePayment } from '@/modules/Contacts/ContactOpeningBalancePayment.service';
import { PaymentEntryTypes } from '@/modules/Contacts/ContactOpeningBalance.constants';
import { PaymentReceivedGLEntries } from '../commands/PaymentReceivedGLEntries';
import { PaymentReceived } from '../models/PaymentReceived';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';

/**
 * Keeps the customer's paid opening balance in sync with the payment lines
 * that pay it, and rewrites those payments' cash entries when the opening
 * balance itself is edited.
 */
@Injectable()
export class PaymentReceivedOpeningBalanceSubscriber {
  constructor(
    private readonly openingBalancePayment: ContactOpeningBalancePayment,
    private readonly paymentReceivedGLEntries: PaymentReceivedGLEntries,

    @Inject(PaymentReceived.name)
    private readonly paymentReceivedModel: TenantModelProxy<
      typeof PaymentReceived
    >,
  ) {}

  @OnEvent(events.paymentReceive.onCreated)
  async handlePaymentCreated({
    paymentReceive,
    trx,
  }: IPaymentReceivedCreatedPayload) {
    await this.openingBalancePayment.syncPaidAmount(
      { contactId: paymentReceive.customerId, entries: paymentReceive.entries },
      null,
      trx,
    );
  }

  @OnEvent(events.paymentReceive.onEdited)
  async handlePaymentEdited({
    paymentReceive,
    oldPaymentReceive,
    trx,
  }: IPaymentReceivedEditedPayload) {
    await this.openingBalancePayment.syncPaidAmount(
      { contactId: paymentReceive.customerId, entries: paymentReceive.entries },
      {
        contactId: oldPaymentReceive.customerId,
        entries: oldPaymentReceive.entries,
      },
      trx,
    );
  }

  @OnEvent(events.paymentReceive.onDeleted)
  async handlePaymentDeleted({
    oldPaymentReceive,
    trx,
  }: IPaymentReceivedDeletedPayload) {
    await this.openingBalancePayment.syncPaidAmount(
      null,
      {
        contactId: oldPaymentReceive.customerId,
        entries: oldPaymentReceive.entries,
      },
      trx,
    );
  }

  /**
   * Rewrites the cash entries of the customer payments that pay the opening
   * balance, since they post to the opening balance account.
   */
  @OnEvent(events.customers.onOpeningBalanceChanged)
  async handleOpeningBalanceChanged({
    customer,
    trx,
  }: ICustomerOpeningBalanceEditedPayload) {
    const payments = await this.paymentReceivedModel()
      .query(trx)
      .where('customer_id', customer.id)
      .whereIn('id', (builder) =>
        builder
          .select('payment_receive_id')
          .from('payment_receives_entries')
          .where('entry_type', PaymentEntryTypes.OpeningBalance),
      )
      .select('id');

    for (const payment of payments) {
      await this.paymentReceivedGLEntries.rewritePaymentCashGLEntries(
        payment.id,
        trx,
      );
    }
  }
}
