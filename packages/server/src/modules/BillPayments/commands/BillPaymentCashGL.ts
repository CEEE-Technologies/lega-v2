import * as moment from 'moment';
import { defaultTo, sumBy } from 'lodash';
import { ILedgerEntry } from '@/modules/Ledger/types/Ledger.types';
import { Ledger } from '@/modules/Ledger/Ledger';
import { AccountNormal } from '@/interfaces/Account';
import { ItemEntry } from '@/modules/TransactionItemEntry/models/ItemEntry';
import { Bill } from '@/modules/Bills/models/Bill';
import { AccountingBasis } from '@/common/types/AccountingBasis';
import { BillPayment } from '../models/BillPayment';
import { BillPaymentEntry } from '../models/BillPaymentEntry';
import {
  allocateCumulativeShare,
  balanceEntries,
  moneyGt,
  multiplyMoney,
  roundMoney,
  subtractMoney,
} from '@bigcapital/utils';
import { debitSide, roundLedgerAmount } from '@/utils/ledger-rounding';
import {
  isDocumentEntry,
  isOpeningBalanceEntry,
} from '@/modules/Contacts/ContactOpeningBalance.constants';

/**
 * Records the cash basis journal entries of the bill payment.
 * The cash basis recognizes the purchase expenses of the associated bill(s)
 * once the payment is made instead of the accounts payable.
 *
 * The entries mirror the expense composition of the bill (the cost/inventory
 * accounts, tax payable, discount, and other charges) scaled by the paid
 * proportion of the bill.
 *
 * A line that pays the vendor opening balance recognizes it as expense on
 * the account the opening balance was booked to (Other Expenses).
 *
 * The amount paid but not applied to a bill or the opening balance (the
 * excess) still leaves the bank: it is recorded as a prepaid expense until
 * it is applied.
 */
export class BillPaymentCashGL {
  private readonly billPayment: BillPayment;

  private taxPayableAccountId: number;
  private purchaseDiscountAccountId: number;
  private otherExpensesAccountId: number;
  private prepaidExpensesAccountId: number;
  private openingBalanceAccountId: number | null = null;

  /**
   * Amount paid on each bill by the earlier payments (bill currency), by
   * bill id: the running-total split starts from there.
   */
  private paidBefore: Record<number, number> = {};

  /**
   * Sets the amount paid on each bill by the earlier payments.
   * @param {Record<number, number>} paidBefore - By bill id.
   * @returns {BillPaymentCashGL}
   */
  setPaidBefore(paidBefore: Record<number, number>) {
    this.paidBefore = paidBefore ?? {};
    return this;
  }

  /**
   * Constructor method.
   * @param {BillPayment} billPayment - Bill payment.
   */
  constructor(billPayment: BillPayment) {
    this.billPayment = billPayment;
  }

  /**
   * Sets the tax payable account id.
   * @param {number} taxPayableAccountId - Tax payable account id.
   * @returns {BillPaymentCashGL}
   */
  setTaxPayableAccountId(taxPayableAccountId: number) {
    this.taxPayableAccountId = taxPayableAccountId;
    return this;
  }

  /**
   * Sets the purchase discount account id.
   * @param {number} purchaseDiscountAccountId - Purchase discount account id.
   * @returns {BillPaymentCashGL}
   */
  setPurchaseDiscountAccountId(purchaseDiscountAccountId: number) {
    this.purchaseDiscountAccountId = purchaseDiscountAccountId;
    return this;
  }

  /**
   * Sets the other expenses account id.
   * @param {number} otherExpensesAccountId - Other expenses account id.
   * @returns {BillPaymentCashGL}
   */
  setOtherExpensesAccountId(otherExpensesAccountId: number) {
    this.otherExpensesAccountId = otherExpensesAccountId;
    return this;
  }

  /**
   * Sets the prepaid expenses account id, debited with the excess.
   * @param {number} prepaidExpensesAccountId - Prepaid expenses account id.
   * @returns {BillPaymentCashGL}
   */
  setPrepaidExpensesAccountId(prepaidExpensesAccountId: number) {
    this.prepaidExpensesAccountId = prepaidExpensesAccountId;
    return this;
  }

  /**
   * Sets the account the vendor opening balance was booked to, debited with
   * the opening balance lines.
   * @param {number | null} openingBalanceAccountId
   * @returns {BillPaymentCashGL}
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
    return (this.billPayment.entries || []).some(isOpeningBalanceEntry);
  }

  /**
   * Retrieves the common journal entry of the cash basis entries.
   */
  private get cashEntriesCommonEntry() {
    return {
      credit: 0,
      debit: 0,

      currencyCode: this.billPayment.currencyCode,
      exchangeRate: this.billPayment.exchangeRate,

      transactionId: this.billPayment.id,
      transactionType: 'BillPayment',

      transactionNumber: this.billPayment.paymentNumber,
      referenceNumber: this.billPayment.reference,

      date: moment(this.billPayment.paymentDate).format('YYYY-MM-DD'),
      createdAt: this.billPayment.createdAt,

      branchId: this.billPayment.branchId,

      indexGroup: 50,

      basis: AccountingBasis.Cash,
    };
  }

  /**
   * Retrieves the paid amount of the given payment entry in local currency.
   * @param {BillPaymentEntry} entry - Bill payment entry.
   * @returns {number}
   */
  private getPaymentEntryLocalAmount = (entry: BillPaymentEntry): number => {
    return roundLedgerAmount(
      entry.paymentAmount * defaultTo(this.billPayment.exchangeRate, 1),
    );
  };

  /**
   * Retrieves the part of the payment entry that pays the bill (bill
   * currency): no more than what the earlier payments left to pay. Anything
   * above it is unapplied (prepaid expense), so the set always balances.
   * @param {BillPaymentEntry} entry - Bill payment entry.
   * @returns {number}
   */
  private getPaymentEntryRecognizedAmount = (
    entry: BillPaymentEntry,
  ): number => {
    const remaining = Math.max(
      subtractMoney(
        defaultTo(entry.bill?.total, 0),
        this.paidBefore[entry.billId] || 0,
      ),
      0,
    );
    return Math.min(roundMoney(entry.paymentAmount), remaining);
  };

  /**
   * Retrieves the recognized part of the payment entry in local currency.
   * @param {BillPaymentEntry} entry - Bill payment entry.
   * @returns {number}
   */
  private getPaymentEntryRecognizedLocalAmount = (
    entry: BillPaymentEntry,
  ): number => {
    return multiplyMoney(
      this.getPaymentEntryRecognizedAmount(entry),
      defaultTo(this.billPayment.exchangeRate, 1),
    );
  };

  /**
   * Splits the payment entry over the bill lines with the running-total
   * method (the bill lines recognized after this payment minus those
   * recognized before it), in the bill currency, then converted with the
   * payment rate. Once the bill is fully paid every line ends exact.
   * @param {BillPaymentEntry} entry - Bill payment entry.
   */
  private getPaymentEntryShares = (entry: BillPaymentEntry) => {
    const bill = entry.bill;
    const items = bill.entries || [];
    const taxedItems = items.filter((item) => item.taxAmount > 0);
    const lines = [
      ...items.map((item) => item.totalExcludingTax),
      ...taxedItems.map((item) => item.taxAmount),
      -defaultTo(bill.discountAmount, 0),
      defaultTo(bill.adjustment, 0),
    ];
    const exchangeRate = defaultTo(this.billPayment.exchangeRate, 1);
    const parts = allocateCumulativeShare(
      this.paidBefore[entry.billId] || 0,
      this.getPaymentEntryRecognizedAmount(entry),
      bill.total,
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
   * Retrieves the payment account (cash/bank) credit entry of the paid amount.
   * @param {BillPaymentEntry} entry - Bill payment entry.
   * @returns {ILedgerEntry}
   */
  private getPaymentEntryPaymentAccountEntry = (
    entry: BillPaymentEntry,
  ): ILedgerEntry => {
    return {
      ...this.cashEntriesCommonEntry,
      credit: this.getPaymentEntryRecognizedLocalAmount(entry),
      accountId: this.billPayment.paymentAccountId,
      index: 1,
      accountNormal: AccountNormal.DEBIT,
    };
  };

  /**
   * Retrieves the cost/inventory accounts debit entries mirroring the bill items.
   * @param {Bill} bill - Bill.
   * @param {number[]} shares - The recognized part of each item (local).
   * @returns {ILedgerEntry[]}
   */
  private getPaymentEntryItemEntries = (
    bill: Bill,
    shares: number[],
  ): ILedgerEntry[] => {
    const billEntries = bill.entries || [];

    return billEntries.map((item, index) =>
      this.getBillItemCashEntry(item, index, shares[index]),
    );
  };

  /**
   * Retrieves the tax payable debit entries mirroring the bill taxes.
   * @param {Bill} bill - Bill.
   * @param {ItemEntry[]} taxedItems - The bill items with tax.
   * @param {number[]} shares - The recognized part of each tax (local).
   * @returns {ILedgerEntry[]}
   */
  private getPaymentEntryTaxEntries = (
    bill: Bill,
    taxedItems: ItemEntry[],
    shares: number[],
  ): ILedgerEntry[] => {
    const billEntries = bill.entries || [];

    return taxedItems.map((item, index) => ({
      ...this.cashEntriesCommonEntry,
      ...debitSide(shares[index]),
      accountId: this.taxPayableAccountId,
      index: billEntries.length + index + 2,
      accountNormal: AccountNormal.CREDIT,
      taxRateId: item.taxRateId,
      taxRate: item.taxRate,
    }));
  };

  /**
   * Retrieves the discount entry mirroring the bill discount.
   * @param {number} share - The recognized part of the discount (local).
   * @returns {ILedgerEntry[]}
   */
  private getPaymentEntryDiscountEntry = (share: number): ILedgerEntry[] => {
    return share
      ? [
          {
            ...this.cashEntriesCommonEntry,
            ...debitSide(-share),
            accountId: this.purchaseDiscountAccountId,
            accountNormal: AccountNormal.DEBIT,
            index: 1,
          },
        ]
      : [];
  };

  /**
   * Retrieves the other charges (adjustment) entry mirroring the bill adjustment.
   * @param {number} share - The recognized part of the adjustment (local).
   * @returns {ILedgerEntry[]}
   */
  private getPaymentEntryAdjustmentEntry = (share: number): ILedgerEntry[] => {
    return share
      ? [
          {
            ...this.cashEntriesCommonEntry,
            ...debitSide(share),
            accountId: this.otherExpensesAccountId,
            accountNormal: AccountNormal.DEBIT,
            index: 1,
          },
        ]
      : [];
  };

  /**
   * Retrieves the cash basis entries of the given payment entry (bill allocation).
   * @param {BillPaymentEntry} entry - Bill payment entry.
   * @returns {ILedgerEntry[]}
   */
  private getPaymentEntryCashEntries = (
    entry: BillPaymentEntry,
  ): ILedgerEntry[] => {
    if (isOpeningBalanceEntry(entry)) {
      return this.getOpeningBalanceEntryCashEntries(entry);
    }
    // A zero-total or missing bill has no expense to recognize; its amount
    // stays in the excess so the payment account line is never dropped.
    if (!this.isExpenseRecognizable(entry)) {
      return [];
    }
    const bill = entry.bill;
    const shares = this.getPaymentEntryShares(entry);

    // Converting each part with a foreign rate can leave a rounding cent:
    // it goes on the largest expense line, never the bank line.
    return balanceEntries(
      [
        this.getPaymentEntryPaymentAccountEntry(entry),
        ...this.getPaymentEntryItemEntries(bill, shares.items),
        ...this.getPaymentEntryTaxEntries(
          bill,
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
   * Determines whether the given payment entry recognizes bill expenses.
   * @param {BillPaymentEntry} entry - Bill payment entry.
   * @returns {boolean}
   */
  private isExpenseRecognizable = (entry: BillPaymentEntry): boolean => {
    return (
      isDocumentEntry(entry) &&
      !!entry.bill &&
      moneyGt(entry.bill.total, 0) &&
      moneyGt(this.getPaymentEntryRecognizedLocalAmount(entry), 0)
    );
  };

  /**
   * Determines whether the given payment entry recognizes opening balance
   * expense. Without the opening balance account the amount stays in the
   * excess, so the payment account line is never dropped.
   * @param {BillPaymentEntry} entry - Bill payment entry.
   * @returns {boolean}
   */
  private isOpeningBalanceRecognizable = (entry: BillPaymentEntry): boolean => {
    return (
      isOpeningBalanceEntry(entry) &&
      !!this.openingBalanceAccountId &&
      this.getPaymentEntryLocalAmount(entry) > 0
    );
  };

  /**
   * Retrieves the cash basis entries of an opening balance line:
   * -----
   * - Opening balance account (expense) -> Debit -> paid amount
   *    - Payment account -> Credit -> paid amount
   * -----
   * @param {BillPaymentEntry} entry - Bill payment entry.
   * @returns {ILedgerEntry[]}
   */
  private getOpeningBalanceEntryCashEntries = (
    entry: BillPaymentEntry,
  ): ILedgerEntry[] => {
    if (!this.isOpeningBalanceRecognizable(entry)) {
      return [];
    }
    const amount = this.getPaymentEntryLocalAmount(entry);
    const commonEntry = {
      ...this.cashEntriesCommonEntry,
      contactId: this.billPayment.vendorId,
    };
    return [
      {
        ...commonEntry,
        credit: amount,
        accountId: this.billPayment.paymentAccountId,
        accountNormal: AccountNormal.DEBIT,
        index: 1,
      },
      {
        ...commonEntry,
        debit: amount,
        accountId: this.openingBalanceAccountId,
        accountNormal: AccountNormal.DEBIT,
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
      this.billPayment.amount,
      sumBy(this.billPayment.entries || [], 'paymentAmount'),
    );
    return roundLedgerAmount(
      amount * defaultTo(this.billPayment.exchangeRate, 1),
    );
  }

  /**
   * Retrieves the payment amount already posted against bills.
   * @returns {number}
   */
  public getBillsPaidAmount(): number {
    return roundLedgerAmount(
      sumBy(
        (this.billPayment.entries || []).filter(this.isExpenseRecognizable),
        this.getPaymentEntryRecognizedLocalAmount,
      ),
    );
  }

  /**
   * Retrieves the payment amount posted against the opening balance.
   * @returns {number}
   */
  public getOpeningBalancePaidAmount(): number {
    return roundLedgerAmount(
      sumBy(
        (this.billPayment.entries || []).filter(
          this.isOpeningBalanceRecognizable,
        ),
        this.getPaymentEntryLocalAmount,
      ),
    );
  }

  /**
   * Retrieves the payment excess in local currency: the amount paid less
   * the amount already posted against bills and the opening balance.
   * @returns {number}
   */
  public getExcessAmount(): number {
    return Math.max(
      roundLedgerAmount(
        this.paymentLocalAmount -
          this.getBillsPaidAmount() -
          this.getOpeningBalancePaidAmount(),
      ),
      0,
    );
  }

  /**
   * Retrieves the excess entries:
   * -----
   * - Prepaid expenses -> Debit -> excess
   *    - Payment account -> Credit -> excess
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
      contactId: this.billPayment.vendorId,
    };
    const paymentAccountEntry: ILedgerEntry = {
      ...commonEntry,
      credit: excess,
      accountId: this.billPayment.paymentAccountId,
      accountNormal: AccountNormal.DEBIT,
      index: 1,
    };
    const prepaidExpensesEntry: ILedgerEntry = {
      ...commonEntry,
      debit: excess,
      accountId: this.prepaidExpensesAccountId,
      accountNormal: AccountNormal.DEBIT,
      index: 3,
    };
    return [paymentAccountEntry, prepaidExpensesEntry];
  };

  /**
   * Retrieves the cash basis entry of the given bill item.
   * @param {ItemEntry} item - Bill item entry.
   * @param {number} index - Item entry index.
   * @param {number} share - The recognized part of the item (local).
   * @returns {ILedgerEntry}
   */
  private getBillItemCashEntry = (
    item: ItemEntry,
    index: number,
    share: number,
  ): ILedgerEntry => {
    return {
      ...this.cashEntriesCommonEntry,
      ...debitSide(share),
      accountId:
        ['inventory'].indexOf(item.item.type) !== -1
          ? item.item.inventoryAccountId
          : item.costAccountId,
      index: index + 2,
      itemId: item.itemId,
      accountNormal: AccountNormal.DEBIT,
    };
  };

  /**
   * Retrieves the bill payment cash basis GL entries.
   * @returns {ILedgerEntry[]}
   */
  public GLEntries(): ILedgerEntry[] {
    return [
      ...(this.billPayment.entries || []).flatMap(
        this.getPaymentEntryCashEntries,
      ),
      ...this.getExcessEntries(),
    ];
  }

  /**
   * Retrieves the bill payment cash basis ledger.
   * @returns {Ledger}
   */
  public getLedger = (): Ledger => {
    return new Ledger(this.GLEntries());
  };
}
