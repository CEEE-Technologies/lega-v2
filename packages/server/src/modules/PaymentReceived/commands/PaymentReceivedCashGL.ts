import { defaultTo, sumBy } from 'lodash';
import { ILedgerEntry } from '@/modules/Ledger/types/Ledger.types';
import { Ledger } from '@/modules/Ledger/Ledger';
import { AccountNormal } from '@/interfaces/Account';
import { PaymentReceived } from '../models/PaymentReceived';
import { PaymentReceivedEntry } from '../models/PaymentReceivedEntry';
import { SaleInvoice } from '@/modules/SaleInvoices/models/SaleInvoice';
import { AccountingBasis } from '@/common/types/AccountingBasis';
import { roundLedgerAmount, roundLedgerEntries } from '@/utils/ledger-rounding';
import {
  isDocumentEntry,
  isOpeningBalanceEntry,
} from '@/modules/Contacts/ContactOpeningBalance.constants';

/**
 * Records the cash basis journal entries of the payment received.
 * The cash basis recognizes the income of the associated invoice(s)
 * once the payment is received instead of the account receivable.
 *
 * The entries mirror the income composition of the invoice (the income
 * accounts, tax payable, discount, and other charges) scaled by the paid
 * proportion of the invoice.
 *
 * A line that pays the customer opening balance recognizes it as income on
 * the account the opening balance was booked to (Other Income).
 *
 * The amount received but not applied to an invoice or the opening balance
 * (the excess) is still cash in the bank: it is recorded as unearned revenue
 * until it is applied.
 */
export class PaymentReceivedCashGL {
  private readonly paymentReceived: PaymentReceived;

  private taxPayableAccountId: number;
  private discountAccountId: number;
  private otherChargesAccountId: number;
  private unearnedRevenueAccountId: number;
  private openingBalanceAccountId: number | null = null;

  /**
   * Constructor method.
   * @param {PaymentReceived} paymentReceived - Payment received.
   */
  constructor(paymentReceived: PaymentReceived) {
    this.paymentReceived = paymentReceived;
  }

  /**
   * Sets the tax payable account id.
   * @param {number} taxPayableAccountId - Tax payable account id.
   * @returns {PaymentReceivedCashGL}
   */
  setTaxPayableAccountId(taxPayableAccountId: number) {
    this.taxPayableAccountId = taxPayableAccountId;
    return this;
  }

  /**
   * Sets the discount account id.
   * @param {number} discountAccountId - Discount account id.
   * @returns {PaymentReceivedCashGL}
   */
  setDiscountAccountId(discountAccountId: number) {
    this.discountAccountId = discountAccountId;
    return this;
  }

  /**
   * Sets the other charges account id.
   * @param {number} otherChargesAccountId - Other charges account id.
   * @returns {PaymentReceivedCashGL}
   */
  setOtherChargesAccountId(otherChargesAccountId: number) {
    this.otherChargesAccountId = otherChargesAccountId;
    return this;
  }

  /**
   * Sets the unearned revenue account id, credited with the excess.
   * @param {number} unearnedRevenueAccountId - Unearned revenue account id.
   * @returns {PaymentReceivedCashGL}
   */
  setUnearnedRevenueAccountId(unearnedRevenueAccountId: number) {
    this.unearnedRevenueAccountId = unearnedRevenueAccountId;
    return this;
  }

  /**
   * Sets the account the customer opening balance was booked to, credited
   * with the opening balance lines.
   * @param {number | null} openingBalanceAccountId
   * @returns {PaymentReceivedCashGL}
   */
  setOpeningBalanceAccountId(openingBalanceAccountId: number | null) {
    this.openingBalanceAccountId = openingBalanceAccountId ?? null;
    return this;
  }

  /**
   * Determines whether the payment has a line paying the opening balance.
   * @returns {boolean}
   */
  public hasOpeningBalanceEntries(): boolean {
    return (this.paymentReceived.entries || []).some(isOpeningBalanceEntry);
  }

  /**
   * Retrieves the common journal entry of the cash basis entries.
   */
  private get cashEntriesCommonEntry() {
    return {
      credit: 0,
      debit: 0,

      currencyCode: this.paymentReceived.currencyCode,
      exchangeRate: this.paymentReceived.exchangeRate,

      transactionId: this.paymentReceived.id,
      transactionType: 'PaymentReceive',

      transactionNumber: this.paymentReceived.paymentReceiveNo,
      referenceNumber: this.paymentReceived.referenceNo,

      date: this.paymentReceived.paymentDate,
      userId: this.paymentReceived.userId,
      createdAt: this.paymentReceived.createdAt,

      branchId: this.paymentReceived.branchId,

      indexGroup: 50,
      basis: AccountingBasis.Cash,
    };
  }

  /**
   * Retrieves the paid amount of the given payment entry in local currency.
   * @param {PaymentReceivedEntry} entry - Payment received entry.
   * @returns {number}
   */
  private getPaymentEntryLocalAmount = (
    entry: PaymentReceivedEntry,
  ): number => {
    return roundLedgerAmount(
      entry.paymentAmount * defaultTo(this.paymentReceived.exchangeRate, 1),
    );
  };

  /**
   * Retrieves the paid proportion of the associated invoice.
   * The paid amount in local currency over the invoice total in local
   * currency keeps the cash basis entries balanced for partial payments.
   * @param {PaymentReceivedEntry} entry - Payment received entry.
   * @returns {number}
   */
  private getPaymentEntryRatio = (entry: PaymentReceivedEntry): number => {
    const invoiceTotalLocal = defaultTo(entry.invoice?.totalLocal, 0);
    const paidLocalAmount = this.getPaymentEntryLocalAmount(entry);

    if (invoiceTotalLocal <= 0) {
      return 0;
    }
    return paidLocalAmount / invoiceTotalLocal;
  };

  /**
   * Retrieves the deposit account (cash/bank) debit entry of the given payment entry.
   * @param {PaymentReceivedEntry} entry - Payment received entry.
   * @returns {ILedgerEntry}
   */
  private getPaymentEntryDepositEntry = (
    entry: PaymentReceivedEntry,
  ): ILedgerEntry => {
    return {
      ...this.cashEntriesCommonEntry,
      debit: this.getPaymentEntryLocalAmount(entry),
      accountId: this.paymentReceived.depositAccountId,
      index: 1,
      accountNormal: AccountNormal.DEBIT,
    };
  };

  /**
   * Retrieves the income accounts credit entries mirroring the invoice items.
   * @param {SaleInvoice} invoice - Sale invoice.
   * @param {number} ratio - Paid proportion of the invoice.
   * @returns {ILedgerEntry[]}
   */
  private getPaymentEntryIncomeEntries = (
    invoice: SaleInvoice,
    ratio: number,
  ): ILedgerEntry[] => {
    const invoiceEntries = invoice.entries || [];

    return invoiceEntries.map((item, index) => ({
      ...this.cashEntriesCommonEntry,
      credit: item.totalExcludingTax * invoice.exchangeRate * ratio,
      accountId: item.sellAccountId,
      note: item.description,
      index: index + 2,
      itemId: item.itemId,
      accountNormal: AccountNormal.CREDIT,
      taxRateId: item.taxRateId,
      taxRate: item.taxRate,
    }));
  };

  /**
   * Retrieves the tax payable credit entries mirroring the invoice taxes.
   * @param {SaleInvoice} invoice - Sale invoice.
   * @param {number} ratio - Paid proportion of the invoice.
   * @returns {ILedgerEntry[]}
   */
  private getPaymentEntryTaxEntries = (
    invoice: SaleInvoice,
    ratio: number,
  ): ILedgerEntry[] => {
    const invoiceEntries = invoice.entries || [];

    return invoiceEntries
      .filter((item) => item.taxAmount > 0)
      .map((item, index) => ({
        ...this.cashEntriesCommonEntry,
        credit: item.taxAmount * invoice.exchangeRate * ratio,
        accountId: this.taxPayableAccountId,
        index: invoiceEntries.length + index + 2,
        accountNormal: AccountNormal.CREDIT,
        taxRateId: item.taxRateId,
        taxRate: item.taxRate,
      }));
  };

  /**
   * Retrieves the discount entry mirroring the invoice discount.
   * @param {SaleInvoice} invoice - Sale invoice.
   * @param {number} ratio - Paid proportion of the invoice.
   * @returns {ILedgerEntry[]}
   */
  private getPaymentEntryDiscountEntry = (
    invoice: SaleInvoice,
    ratio: number,
  ): ILedgerEntry[] => {
    return invoice.discountAmountLocal
      ? [
          {
            ...this.cashEntriesCommonEntry,
            debit: invoice.discountAmountLocal * ratio,
            accountId: this.discountAccountId,
            accountNormal: AccountNormal.CREDIT,
            index: 1,
          },
        ]
      : [];
  };

  /**
   * Retrieves the other charges (adjustment) entry mirroring the invoice adjustment.
   * @param {SaleInvoice} invoice - Sale invoice.
   * @param {number} ratio - Paid proportion of the invoice.
   * @returns {ILedgerEntry[]}
   */
  private getPaymentEntryAdjustmentEntry = (
    invoice: SaleInvoice,
    ratio: number,
  ): ILedgerEntry[] => {
    const adjustmentAmount = defaultTo(invoice.adjustmentLocal, 0);

    return invoice.adjustmentLocal
      ? [
          {
            ...this.cashEntriesCommonEntry,
            debit:
              adjustmentAmount < 0 ? Math.abs(adjustmentAmount) * ratio : 0,
            credit: adjustmentAmount > 0 ? adjustmentAmount * ratio : 0,
            accountId: this.otherChargesAccountId,
            accountNormal: AccountNormal.CREDIT,
            index: 1,
          },
        ]
      : [];
  };

  /**
   * Retrieves the cash basis entries of the given payment entry (invoice allocation).
   * @param {PaymentReceivedEntry} entry - Payment received entry.
   * @returns {ILedgerEntry[]}
   */
  private getPaymentEntryCashEntries = (
    entry: PaymentReceivedEntry,
  ): ILedgerEntry[] => {
    if (isOpeningBalanceEntry(entry)) {
      return this.getOpeningBalanceEntryCashEntries(entry);
    }
    // A zero-total or missing invoice has no income to recognize; its
    // amount stays in the excess so the bank line is never dropped.
    if (!this.isIncomeRecognizable(entry)) {
      return [];
    }
    const invoice = entry.invoice;
    const ratio = this.getPaymentEntryRatio(entry);

    return roundLedgerEntries([
      this.getPaymentEntryDepositEntry(entry),
      ...this.getPaymentEntryIncomeEntries(invoice, ratio),
      ...this.getPaymentEntryTaxEntries(invoice, ratio),
      ...this.getPaymentEntryDiscountEntry(invoice, ratio),
      ...this.getPaymentEntryAdjustmentEntry(invoice, ratio),
    ]);
  };

  /**
   * Determines whether the given payment entry recognizes invoice income.
   * @param {PaymentReceivedEntry} entry - Payment received entry.
   * @returns {boolean}
   */
  private isIncomeRecognizable = (entry: PaymentReceivedEntry): boolean => {
    return (
      isDocumentEntry(entry) &&
      !!entry.invoice &&
      this.getPaymentEntryRatio(entry) > 0 &&
      this.getPaymentEntryLocalAmount(entry) > 0
    );
  };

  /**
   * Determines whether the given payment entry recognizes opening balance
   * income. Without the opening balance account the amount stays in the
   * excess, so the bank line is never dropped.
   * @param {PaymentReceivedEntry} entry - Payment received entry.
   * @returns {boolean}
   */
  private isOpeningBalanceRecognizable = (
    entry: PaymentReceivedEntry,
  ): boolean => {
    return (
      isOpeningBalanceEntry(entry) &&
      !!this.openingBalanceAccountId &&
      this.getPaymentEntryLocalAmount(entry) > 0
    );
  };

  /**
   * Retrieves the cash basis entries of an opening balance line:
   * -----
   * - Deposit account -> Debit -> paid amount
   *    - Opening balance account (income) -> Credit -> paid amount
   * -----
   * @param {PaymentReceivedEntry} entry - Payment received entry.
   * @returns {ILedgerEntry[]}
   */
  private getOpeningBalanceEntryCashEntries = (
    entry: PaymentReceivedEntry,
  ): ILedgerEntry[] => {
    if (!this.isOpeningBalanceRecognizable(entry)) {
      return [];
    }
    const amount = this.getPaymentEntryLocalAmount(entry);
    const commonEntry = {
      ...this.cashEntriesCommonEntry,
      contactId: this.paymentReceived.customerId,
    };
    return [
      {
        ...commonEntry,
        debit: amount,
        accountId: this.paymentReceived.depositAccountId,
        accountNormal: AccountNormal.DEBIT,
        index: 1,
      },
      {
        ...commonEntry,
        credit: amount,
        accountId: this.openingBalanceAccountId,
        accountNormal: AccountNormal.CREDIT,
        note: 'Opening balance',
        index: 2,
      },
    ];
  };

  /**
   * Retrieves the payment amount in local currency. Falls back to the sum of
   * the applied amounts when the payment amount is not set.
   * @returns {number}
   */
  private get paymentLocalAmount(): number {
    const amount = defaultTo(
      this.paymentReceived.amount,
      sumBy(this.paymentReceived.entries || [], 'paymentAmount'),
    );
    return roundLedgerAmount(
      amount * defaultTo(this.paymentReceived.exchangeRate, 1),
    );
  }

  /**
   * Retrieves the deposit amount already posted against invoices.
   * @returns {number}
   */
  public getInvoicesDepositAmount(): number {
    return roundLedgerAmount(
      sumBy(
        (this.paymentReceived.entries || []).filter(this.isIncomeRecognizable),
        this.getPaymentEntryLocalAmount,
      ),
    );
  }

  /**
   * Retrieves the deposit amount posted against the opening balance.
   * @returns {number}
   */
  public getOpeningBalanceDepositAmount(): number {
    return roundLedgerAmount(
      sumBy(
        (this.paymentReceived.entries || []).filter(
          this.isOpeningBalanceRecognizable,
        ),
        this.getPaymentEntryLocalAmount,
      ),
    );
  }

  /**
   * Retrieves the payment excess in local currency: the amount received
   * less the deposit amount already posted against invoices and the
   * opening balance.
   * @returns {number}
   */
  public getExcessAmount(): number {
    return Math.max(
      roundLedgerAmount(
        this.paymentLocalAmount -
          this.getInvoicesDepositAmount() -
          this.getOpeningBalanceDepositAmount(),
      ),
      0,
    );
  }

  /**
   * Retrieves the excess entries:
   * -----
   * - Deposit account -> Debit -> excess
   *    - Unearned revenue -> Credit -> excess
   * -----
   * @returns {ILedgerEntry[]}
   */
  private getExcessEntries = (): ILedgerEntry[] => {
    const excess = this.getExcessAmount();

    if (excess <= 0) {
      return [];
    }
    const commonEntry = {
      ...this.cashEntriesCommonEntry,
      contactId: this.paymentReceived.customerId,
    };
    const depositEntry: ILedgerEntry = {
      ...commonEntry,
      debit: excess,
      accountId: this.paymentReceived.depositAccountId,
      accountNormal: AccountNormal.DEBIT,
      index: 1,
    };
    const unearnedRevenueEntry: ILedgerEntry = {
      ...commonEntry,
      credit: excess,
      accountId: this.unearnedRevenueAccountId,
      accountNormal: AccountNormal.CREDIT,
      index: 3,
    };
    return [depositEntry, unearnedRevenueEntry];
  };

  /**
   * Retrieves the payment received cash basis GL entries.
   * @returns {ILedgerEntry[]}
   */
  public GLEntries(): ILedgerEntry[] {
    return [
      ...(this.paymentReceived.entries || []).flatMap(
        this.getPaymentEntryCashEntries,
      ),
      ...this.getExcessEntries(),
    ];
  }

  /**
   * Retrieves the payment received cash basis ledger.
   * @returns {Ledger}
   */
  public getLedger = (): Ledger => {
    return new Ledger(this.GLEntries());
  };
}
