import { defaultTo, sumBy } from 'lodash';
import { ILedgerEntry } from '@/modules/Ledger/types/Ledger.types';
import { Ledger } from '@/modules/Ledger/Ledger';
import { AccountNormal } from '@/interfaces/Account';
import { PaymentReceived } from '../models/PaymentReceived';
import { PaymentReceivedEntry } from '../models/PaymentReceivedEntry';
import { SaleInvoice } from '@/modules/SaleInvoices/models/SaleInvoice';
import { AccountingBasis } from '@/common/types/AccountingBasis';
import {
  allocateCumulativeShare,
  balanceEntries,
  moneyGt,
  multiplyMoney,
  roundMoney,
  subtractMoney,
} from '@bigcapital/utils';
import { creditSide, roundLedgerAmount } from '@/utils/ledger-rounding';
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
   * Amount paid on each invoice by the earlier payments (invoice currency),
   * by invoice id: the running-total split starts from there.
   */
  private paidBefore: Record<number, number> = {};

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
   * Sets the amount paid on each invoice by the earlier payments.
   * @param {Record<number, number>} paidBefore - By invoice id.
   * @returns {PaymentReceivedCashGL}
   */
  setPaidBefore(paidBefore: Record<number, number>) {
    this.paidBefore = paidBefore ?? {};
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
   * Retrieves the part of the payment entry that pays the invoice (invoice
   * currency): no more than what the earlier payments left to pay. Anything
   * above it is unapplied (unearned revenue), so the set always balances.
   * @param {PaymentReceivedEntry} entry - Payment received entry.
   * @returns {number}
   */
  private getPaymentEntryRecognizedAmount = (
    entry: PaymentReceivedEntry,
  ): number => {
    const remaining = Math.max(
      subtractMoney(
        defaultTo(entry.invoice?.total, 0),
        this.paidBefore[entry.invoiceId] || 0,
      ),
      0,
    );
    return Math.min(roundMoney(entry.paymentAmount), remaining);
  };

  /**
   * Retrieves the recognized part of the payment entry in local currency.
   * @param {PaymentReceivedEntry} entry - Payment received entry.
   * @returns {number}
   */
  private getPaymentEntryRecognizedLocalAmount = (
    entry: PaymentReceivedEntry,
  ): number => {
    return multiplyMoney(
      this.getPaymentEntryRecognizedAmount(entry),
      defaultTo(this.paymentReceived.exchangeRate, 1),
    );
  };

  /**
   * Splits the payment entry over the invoice lines with the running-total
   * method: the invoice lines recognized after this payment (the earlier
   * payments on the invoice plus this one) minus those recognized before
   * it. The split is in the invoice currency, then converted with the
   * payment rate. Once the invoice is fully paid, every line ends exactly
   * at its amount (no 99.999 / 100.002 cent gaps).
   * @param {PaymentReceivedEntry} entry - Payment received entry.
   */
  private getPaymentEntryShares = (entry: PaymentReceivedEntry) => {
    const invoice = entry.invoice;
    const items = invoice.entries || [];
    const taxedItems = items.filter((item) => item.taxAmount > 0);
    const lines = [
      ...items.map((item) => item.totalExcludingTax),
      ...taxedItems.map((item) => item.taxAmount),
      -defaultTo(invoice.discountAmount, 0),
      defaultTo(invoice.adjustment, 0),
    ];
    const exchangeRate = defaultTo(this.paymentReceived.exchangeRate, 1);
    const parts = allocateCumulativeShare(
      this.paidBefore[entry.invoiceId] || 0,
      this.getPaymentEntryRecognizedAmount(entry),
      invoice.total,
      lines,
    ).map((part) => multiplyMoney(part, exchangeRate));

    const itemsCount = items.length;
    const taxesCount = taxedItems.length;

    return {
      items: parts.slice(0, itemsCount),
      taxedItems,
      taxes: parts.slice(itemsCount, itemsCount + taxesCount),
      discount: -parts[itemsCount + taxesCount],
      adjustment: parts[itemsCount + taxesCount + 1],
    };
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
      debit: this.getPaymentEntryRecognizedLocalAmount(entry),
      accountId: this.paymentReceived.depositAccountId,
      index: 1,
      accountNormal: AccountNormal.DEBIT,
    };
  };

  /**
   * Retrieves the income accounts credit entries mirroring the invoice items.
   * @param {SaleInvoice} invoice - Sale invoice.
   * @param {number[]} shares - The recognized part of each item (local).
   * @returns {ILedgerEntry[]}
   */
  private getPaymentEntryIncomeEntries = (
    invoice: SaleInvoice,
    shares: number[],
  ): ILedgerEntry[] => {
    const invoiceEntries = invoice.entries || [];

    return invoiceEntries.map((item, index) => ({
      ...this.cashEntriesCommonEntry,
      ...creditSide(shares[index]),
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
   * @param {ItemEntry[]} taxedItems - The invoice items with tax.
   * @param {number[]} shares - The recognized part of each tax (local).
   * @returns {ILedgerEntry[]}
   */
  private getPaymentEntryTaxEntries = (
    invoice: SaleInvoice,
    taxedItems: SaleInvoice['entries'],
    shares: number[],
  ): ILedgerEntry[] => {
    const invoiceEntries = invoice.entries || [];

    return taxedItems.map((item, index) => ({
      ...this.cashEntriesCommonEntry,
      ...creditSide(shares[index]),
      accountId: this.taxPayableAccountId,
      index: invoiceEntries.length + index + 2,
      accountNormal: AccountNormal.CREDIT,
      taxRateId: item.taxRateId,
      taxRate: item.taxRate,
    }));
  };

  /**
   * Retrieves the discount entry mirroring the invoice discount.
   * @param {number} share - The recognized part of the discount (local).
   * @returns {ILedgerEntry[]}
   */
  private getPaymentEntryDiscountEntry = (share: number): ILedgerEntry[] => {
    return share
      ? [
          {
            ...this.cashEntriesCommonEntry,
            ...creditSide(-share),
            accountId: this.discountAccountId,
            accountNormal: AccountNormal.CREDIT,
            index: 1,
          },
        ]
      : [];
  };

  /**
   * Retrieves the other charges (adjustment) entry mirroring the invoice adjustment.
   * @param {number} share - The recognized part of the adjustment (local).
   * @returns {ILedgerEntry[]}
   */
  private getPaymentEntryAdjustmentEntry = (share: number): ILedgerEntry[] => {
    return share
      ? [
          {
            ...this.cashEntriesCommonEntry,
            ...creditSide(share),
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
    const shares = this.getPaymentEntryShares(entry);

    // Converting each part with a foreign rate can leave a rounding cent:
    // it goes on the largest income line, never the bank line.
    return balanceEntries(
      [
        this.getPaymentEntryDepositEntry(entry),
        ...this.getPaymentEntryIncomeEntries(invoice, shares.items),
        ...this.getPaymentEntryTaxEntries(
          invoice,
          shares.taxedItems,
          shares.taxes,
        ),
        ...this.getPaymentEntryDiscountEntry(shares.discount),
        ...this.getPaymentEntryAdjustmentEntry(shares.adjustment),
      ],
      { canAbsorb: (e) => e.itemId !== undefined && e.itemId !== null },
    ).entries;
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
      moneyGt(entry.invoice.total, 0) &&
      moneyGt(this.getPaymentEntryRecognizedLocalAmount(entry), 0)
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
        this.getPaymentEntryRecognizedLocalAmount,
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
