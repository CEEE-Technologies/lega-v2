import { Inject, Injectable } from '@nestjs/common';
import { omit } from 'lodash';
import { sumMoney } from '@bigcapital/utils';
import { IPaymentReceivePageEntry } from '../types/PaymentReceived.types';
import { ERRORS } from '../constants';
import { SaleInvoice } from '@/modules/SaleInvoices/models/SaleInvoice';
import { PaymentReceived } from '../models/PaymentReceived';
import { ServiceError } from '@/modules/Items/ServiceError';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { Customer } from '@/modules/Customers/models/Customer';
import {
  PaymentEntryTypes,
  isDocumentEntry,
  isOpeningBalanceEntry,
} from '@/modules/Contacts/ContactOpeningBalance.constants';

/**
 * Payment receives edit/new pages service.
 */
@Injectable()
export class PaymentsReceivedPagesService {
  constructor(
    @Inject(SaleInvoice.name)
    private readonly saleInvoice: TenantModelProxy<typeof SaleInvoice>,

    @Inject(PaymentReceived.name)
    private readonly paymentReceived: TenantModelProxy<typeof PaymentReceived>,

    @Inject(Customer.name)
    private readonly customerModel: TenantModelProxy<typeof Customer>,
  ) {}

  /**
   * Retrive page invoices entries from the given sale invoices models.
   * @param  {ISaleInvoice[]} invoices - Invoices.
   * @return {IPaymentReceivePageEntry}
   */
  private invoiceToPageEntry(invoice: SaleInvoice): IPaymentReceivePageEntry {
    return {
      entryType: PaymentEntryTypes.Invoice,
      invoiceId: invoice.id,
      invoiceNo: invoice.invoiceNo,
      amount: invoice.total,
      dueAmount: invoice.dueAmount,
      paymentAmount: invoice.paymentAmount,
      totalPaymentAmount: invoice.paymentAmount,
      currencyCode: invoice.currencyCode,
      date: invoice.invoiceDate,
    };
  }

  /**
   * Retrieves the opening balance row of the given customer: an open item
   * dated on the opening balance date, due the unpaid part.
   * @param {Customer} customer - Customer.
   * @param {number} thisPaymentAmount - What the edited payment pays of it.
   * @return {IPaymentReceivePageEntry}
   */
  private openingBalanceToPageEntry(
    customer: Customer,
    thisPaymentAmount: number = 0,
  ): IPaymentReceivePageEntry {
    return {
      entryType: PaymentEntryTypes.OpeningBalance,
      invoiceId: null,
      invoiceNo: null,
      amount: customer.openingBalance,
      dueAmount: sumMoney(customer.openingBalanceDueAmount, thisPaymentAmount),
      paymentAmount: thisPaymentAmount,
      totalPaymentAmount: customer.openingBalancePaymentAmount,
      currencyCode: customer.currencyCode,
      date: customer.openingBalanceAt,
    };
  }

  /**
   * Retrieves the opening balance row when the customer has an unpaid
   * opening balance, or the edited payment pays part of it.
   */
  private async getOpeningBalancePageEntries(
    customerId: number,
    thisPaymentAmount: number = 0,
  ): Promise<IPaymentReceivePageEntry[]> {
    const customer = await this.customerModel().query().findById(customerId);

    if (!customer || !(customer.openingBalance > 0)) return [];

    const entry = this.openingBalanceToPageEntry(customer, thisPaymentAmount);

    return entry.dueAmount > 0 || thisPaymentAmount > 0 ? [entry] : [];
  }

  /**
   * Retrieve payment receive new page receivable entries: the unpaid
   * opening balance first (the oldest item), then the due invoices.
   * @param {number} customerId - Customer id.
   * @return {IPaymentReceivePageEntry[]}
   */
  public async getNewPageEntries(customerId: number) {
    const openingBalanceEntries =
      await this.getOpeningBalancePageEntries(customerId);

    // Retrieve due invoices.
    const invoices = await this.saleInvoice()
      .query()
      .modify('delivered')
      .modify('dueInvoices')
      .where('customer_id', customerId)
      .orderBy('invoice_date', 'ASC');

    return [
      ...openingBalanceEntries,
      ...invoices.map((invoice) => this.invoiceToPageEntry(invoice)),
    ];
  }

  /**
   * Retrieve the payment receive details of the given id.
   * @param {number} paymentReceiveId - Payment receive id.
   */
  public async getPaymentReceiveEditPage(paymentReceiveId: number): Promise<{
    data: Omit<PaymentReceived, 'entries'>;
    entries: IPaymentReceivePageEntry[];
  }> {
    // Retrieve payment receive.
    const paymentReceive = await this.paymentReceived()
      .query()
      .findById(paymentReceiveId)
      .withGraphFetched('entries.invoice')
      .withGraphFetched('attachments');

    // Throw not found the payment receive.
    if (!paymentReceive) {
      throw new ServiceError(ERRORS.PAYMENT_RECEIVE_NOT_EXISTS);
    }
    const invoiceEntries = paymentReceive.entries.filter(
      (entry) => isDocumentEntry(entry) && entry.invoice,
    );
    const openingBalanceEntry = paymentReceive.entries.find(
      isOpeningBalanceEntry,
    );
    // The opening balance row comes first, with this payment's amount.
    const openingBalanceEntries = (
      await this.getOpeningBalancePageEntries(
        paymentReceive.customerId,
        openingBalanceEntry?.paymentAmount || 0,
      )
    ).map((entry) => ({ ...entry, index: openingBalanceEntry?.index }));

    const paymentEntries = invoiceEntries.map((entry) => ({
      ...this.invoiceToPageEntry(entry.invoice),
      dueAmount: sumMoney(entry.invoice.dueAmount, entry.paymentAmount),
      paymentAmount: entry.paymentAmount,
      index: entry.index,
    }));
    // Retrieves all receivable bills that associated to the payment receive transaction.
    const restReceivableInvoices = await this.saleInvoice()
      .query()
      .modify('delivered')
      .modify('dueInvoices')
      .where('customer_id', paymentReceive.customerId)
      .whereNotIn(
        'id',
        invoiceEntries.map((entry) => entry.invoiceId),
      )
      .orderBy('invoice_date', 'ASC');

    const restReceivableEntries = restReceivableInvoices.map((invoice) =>
      this.invoiceToPageEntry(invoice),
    );
    const entries = [
      ...openingBalanceEntries,
      ...paymentEntries,
      ...restReceivableEntries,
    ];

    return {
      data: omit(paymentReceive, ['entries']),
      entries,
    };
  }
}
