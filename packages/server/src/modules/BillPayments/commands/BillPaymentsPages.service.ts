import { omit } from 'lodash';
import { sumMoney } from '@bigcapital/utils';
import { ERRORS } from '../constants';
import { Inject, Injectable } from '@nestjs/common';
import { Bill } from '../../Bills/models/Bill';
import { BillPayment } from '../models/BillPayment';
import { IBillReceivePageEntry } from '../types/BillPayments.types';
import { ServiceError } from '../../Items/ServiceError';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { Vendor } from '@/modules/Vendors/models/Vendor';
import {
  PaymentEntryTypes,
  isDocumentEntry,
  isOpeningBalanceEntry,
} from '@/modules/Contacts/ContactOpeningBalance.constants';

@Injectable()
export class BillPaymentsPages {
  /**
   * @param {TenantModelProxy<typeof Bill>} billModel - Bill model.
   * @param {TenantModelProxy<typeof BillPayment>} billPaymentModel - Bill payment model.
   * @param {TenantModelProxy<typeof Vendor>} vendorModel - Vendor model.
   */
  constructor(
    @Inject(Bill.name)
    private readonly billModel: TenantModelProxy<typeof Bill>,

    @Inject(BillPayment.name)
    private readonly billPaymentModel: TenantModelProxy<typeof BillPayment>,

    @Inject(Vendor.name)
    private readonly vendorModel: TenantModelProxy<typeof Vendor>,
  ) {}

  /**
   * Retrieve bill payment with associated metadata.
   * @param {number} billPaymentId - The bill payment id.
   * @return {object}
   */
  public async getBillPaymentEditPage(billPaymentId: number): Promise<{
    billPayment: Omit<BillPayment, 'entries'>;
    entries: IBillReceivePageEntry[];
  }> {
    const billPayment = await this.billPaymentModel()
      .query()
      .findById(billPaymentId)
      .withGraphFetched('entries.bill')
      .withGraphFetched('attachments');

    // Throw not found the bill payment.
    if (!billPayment) {
      throw new ServiceError(ERRORS.PAYMENT_MADE_NOT_FOUND);
    }
    const billEntries = billPayment.entries.filter(
      (entry) => isDocumentEntry(entry) && entry.bill,
    );
    const openingBalanceEntry = billPayment.entries.find(isOpeningBalanceEntry);

    // The opening balance row comes first, with this payment's amount.
    const openingBalanceEntries = await this.getOpeningBalancePageEntries(
      billPayment.vendorId,
      openingBalanceEntry?.paymentAmount || 0,
    );
    const paymentEntries = billEntries.map((entry) => ({
      ...this.mapBillToPageEntry(entry.bill),
      dueAmount: sumMoney(entry.bill.dueAmount, entry.paymentAmount),
      paymentAmount: entry.paymentAmount,
    }));

    const resPayableBills = await this.billModel()
      .query()
      .modify('opened')
      .modify('dueBills')
      .where('vendor_id', billPayment.vendorId)
      .whereNotIn(
        'id',
        billEntries.map((e) => e.billId),
      )
      .orderBy('bill_date', 'ASC');

    // Mapping the payable bills to entries.
    const restPayableEntries = resPayableBills.map((bill) =>
      this.mapBillToPageEntry(bill),
    );
    const entries = [
      ...openingBalanceEntries,
      ...paymentEntries,
      ...restPayableEntries,
    ];

    return {
      billPayment: omit(billPayment, ['entries']),
      entries,
    };
  }

  /**
   * Retrieve the payable entries of the new page once vendor be selected:
   * the unpaid opening balance first (the oldest item), then the due bills.
   * @param {number} vendorId
   */
  public async getNewPageEntries(
    vendorId: number,
  ): Promise<IBillReceivePageEntry[]> {
    const openingBalanceEntries =
      await this.getOpeningBalancePageEntries(vendorId);

    // Retrieve all payable bills that associated to the payment made transaction.
    const payableBills = await this.billModel()
      .query()
      .modify('opened')
      .modify('dueBills')
      .where('vendor_id', vendorId)
      .orderBy('bill_date', 'ASC');

    return [
      ...openingBalanceEntries,
      ...payableBills.map((bill) => this.mapBillToPageEntry(bill)),
    ];
  }

  /**
   * Retrieves the opening balance row when the vendor has an unpaid opening
   * balance, or the edited payment pays part of it.
   * @param {number} vendorId
   * @param {number} thisPaymentAmount - What the edited payment pays of it.
   */
  private async getOpeningBalancePageEntries(
    vendorId: number,
    thisPaymentAmount: number = 0,
  ): Promise<IBillReceivePageEntry[]> {
    const vendor = await this.vendorModel().query().findById(vendorId);

    if (!vendor || !(vendor.openingBalance > 0)) return [];

    const entry: IBillReceivePageEntry = {
      entryType: PaymentEntryTypes.OpeningBalance,
      billId: null,
      billNo: null,
      amount: vendor.openingBalance,
      dueAmount: sumMoney(vendor.openingBalanceDueAmount, thisPaymentAmount),
      totalPaymentAmount: vendor.openingBalancePaymentAmount,
      paymentAmount: thisPaymentAmount,
      currencyCode: vendor.currencyCode,
      date: vendor.openingBalanceAt,
    };
    return entry.dueAmount > 0 || thisPaymentAmount > 0 ? [entry] : [];
  }

  /**
   * Retrive edit page invoices entries from the given sale invoices models.
   * @param {Bill} bill - Bill.
   * @return {IBillReceivePageEntry}
   */
  private mapBillToPageEntry(bill: Bill): IBillReceivePageEntry {
    return {
      entryType: PaymentEntryTypes.Invoice,
      billId: bill.id,
      billNo: bill.billNumber,
      amount: bill.total,
      dueAmount: bill.dueAmount,
      totalPaymentAmount: bill.paymentAmount,
      paymentAmount: bill.paymentAmount,
      currencyCode: bill.currencyCode,
      date: bill.billDate,
    };
  }
}
