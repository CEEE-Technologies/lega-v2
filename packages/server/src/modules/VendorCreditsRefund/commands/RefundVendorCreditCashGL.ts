import { defaultTo } from 'lodash';
import { ILedgerEntry } from '@/modules/Ledger/types/Ledger.types';
import { Ledger } from '@/modules/Ledger/Ledger';
import { AccountNormal } from '@/interfaces/Account';
import { AccountingBasis } from '@/common/types/AccountingBasis';
import { ItemEntry } from '@/modules/TransactionItemEntry/models/ItemEntry';
import { RefundVendorCredit } from '../models/RefundVendorCredit';
import {
  allocateCumulativeShare,
  balanceEntries,
  moneyGt,
  multiplyMoney,
  roundMoney,
  subtractMoney,
} from '@bigcapital/utils';
import {
  creditSide,
  debitSide,
  roundLedgerAmount,
} from '@/utils/ledger-rounding';

/**
 * Records the cash basis journal entries of the vendor credit refund.
 * The cash basis reverses the purchase expenses previously recognized on
 * payments when the vendor credit is actually refunded in cash.
 *
 * The entries mirror the expense composition of the vendor credit (the
 * cost/inventory accounts, purchase discount, and other expenses) scaled by
 * the refunded proportion of the vendor credit.
 *
 * When the vendor credit has no expense to reverse (zero total or missing),
 * the cash still comes into the bank, so the refund reduces the vendor's
 * prepaid expenses instead of dropping the deposit line.
 */
export class RefundVendorCreditCashGL {
  private readonly refundVendorCredit: RefundVendorCredit;

  private purchaseDiscountAccountId: number;
  private otherExpensesAccountId: number;
  private prepaidExpensesAccountId: number;

  /**
   * Constructor method.
   * @param {RefundVendorCredit} refundVendorCredit - Refund vendor credit.
   */
  constructor(refundVendorCredit: RefundVendorCredit) {
    this.refundVendorCredit = refundVendorCredit;
  }

  /**
   * Sets the purchase discount account id.
   * @param {number} purchaseDiscountAccountId - Purchase discount account id.
   * @returns {RefundVendorCreditCashGL}
   */
  public setPurchaseDiscountAccountId(purchaseDiscountAccountId: number) {
    this.purchaseDiscountAccountId = purchaseDiscountAccountId;
    return this;
  }

  /**
   * Sets the other expenses (adjustment) account id.
   * @param {number} otherExpensesAccountId - Other expenses account id.
   * @returns {RefundVendorCreditCashGL}
   */
  public setOtherExpensesAccountId(otherExpensesAccountId: number) {
    this.otherExpensesAccountId = otherExpensesAccountId;
    return this;
  }

  /**
   * Sets the prepaid expenses account id, credited when the vendor credit
   * has no expense to reverse.
   * @param {number} prepaidExpensesAccountId - Prepaid expenses account id.
   * @returns {RefundVendorCreditCashGL}
   */
  /**
   * Amount refunded of the vendor credit by the earlier refunds.
   */
  private refundedBefore = 0;

  /**
   * Sets the amount refunded of the vendor credit by the earlier refunds.
   * @param {number} refundedBefore
   */
  public setRefundedBefore(refundedBefore: number) {
    this.refundedBefore = refundedBefore || 0;
    return this;
  }

  public setPrepaidExpensesAccountId(prepaidExpensesAccountId: number) {
    this.prepaidExpensesAccountId = prepaidExpensesAccountId;
    return this;
  }

  /**
   * Determines whether the refund reverses vendor credit expenses pro-rata.
   * @returns {boolean}
   */
  public isExpenseReversible(): boolean {
    return (
      !!this.vendorCredit &&
      moneyGt(this.vendorCredit.total, 0) &&
      moneyGt(this.recognizedAmount, 0)
    );
  }

  /**
   * Retrieves the common journal entry of the cash basis entries.
   */
  private get cashEntriesCommonEntry() {
    return {
      credit: 0,
      debit: 0,

      currencyCode: this.refundVendorCredit.currencyCode,
      exchangeRate: this.refundVendorCredit.exchangeRate,

      transactionId: this.refundVendorCredit.id,
      transactionType: 'RefundVendorCredit',

      referenceNumber: this.refundVendorCredit.referenceNo,

      date: this.refundVendorCredit.date,
      createdAt: (this.refundVendorCredit as any).createdAt,

      note: this.refundVendorCredit.description,
      branchId: this.refundVendorCredit.branchId,

      indexGroup: 50,

      basis: AccountingBasis.Cash,
    };
  }

  /**
   * Retrieves the vendor credit associated with the refund.
   * @returns {VendorCredit | undefined}
   */
  private get vendorCredit() {
    return this.refundVendorCredit.vendorCredit;
  }

  /**
   * Retrieves the refunded amount in local currency.
   * The refund amount is stored in the vendor credit currency, so it is
   * converted using the vendor credit exchange rate to keep the cash basis
   * entries consistent with the local currency composition of the credit.
   * @returns {number}
   */
  private get refundLocalAmount(): number {
    const exchangeRate = defaultTo(
      this.vendorCredit?.exchangeRate,
      defaultTo(this.refundVendorCredit.exchangeRate, 1),
    );
    return roundLedgerAmount(
      defaultTo(this.refundVendorCredit.amount, 0) * exchangeRate,
    );
  }

  /**
   * The exchange rate of the vendor credit (falls back to the refund's).
   */
  private get vendorCreditRate(): number {
    return defaultTo(
      this.vendorCredit?.exchangeRate,
      defaultTo(this.refundVendorCredit.exchangeRate, 1),
    );
  }

  /**
   * Retrieves the part of the refund that reverses the vendor credit
   * expenses (vendor credit currency): no more than what the earlier refunds
   * left of its total. Anything above it is a prepaid expense.
   * @returns {number}
   */
  private get recognizedAmount(): number {
    const remaining = Math.max(
      subtractMoney(
        defaultTo(this.vendorCredit?.total, 0),
        this.refundedBefore,
      ),
      0,
    );
    return Math.min(
      roundMoney(defaultTo(this.refundVendorCredit.amount, 0)),
      remaining,
    );
  }

  /**
   * Splits the refund over the vendor credit lines with the running-total
   * method, in the vendor credit currency, converted with its rate. Once the
   * vendor credit is fully refunded every line ends exactly at its amount.
   */
  private get shares() {
    const items = this.vendorCredit.entries || [];
    const parts = allocateCumulativeShare(
      this.refundedBefore,
      this.recognizedAmount,
      this.vendorCredit.total,
      [
        ...items.map((item) => item.totalExcludingTax),
        -defaultTo(this.vendorCredit.discountAmount, 0),
        defaultTo(this.vendorCredit.adjustment, 0),
      ],
    ).map((part) => multiplyMoney(part, this.vendorCreditRate));

    return {
      items: parts.slice(0, items.length),
      discount: -parts[items.length],
      adjustment: parts[items.length + 1],
    };
  }

  /**
   * Retrieves the deposit account (cash/bank) debit entry.
   * @returns {ILedgerEntry}
   */
  private get refundEntry(): ILedgerEntry {
    return {
      ...this.cashEntriesCommonEntry,
      debit: this.refundLocalAmount,
      accountId: this.refundVendorCredit.depositAccountId,
      index: 1,
      accountNormal: AccountNormal.DEBIT,
    };
  }

  /**
   * Retrieves the cash basis entry of the given vendor credit item.
   * @param {ItemEntry} item - Vendor credit item entry.
   * @param {number} index - Item entry index.
   * @returns {ILedgerEntry}
   */
  private getVendorCreditItemEntry(
    item: ItemEntry,
    index: number,
    share: number,
  ): ILedgerEntry {
    const commonEntry = this.cashEntriesCommonEntry;

    return {
      ...commonEntry,
      ...creditSide(share),
      accountId:
        'inventory' === item.item.type
          ? item.item.inventoryAccountId
          : item.costAccountId || item.item.costAccountId,
      note: item.description,
      index: index + 2,
      itemId: item.itemId,
      accountNormal: AccountNormal.DEBIT,
    };
  }

  /**
   * Retrieves the purchase discount entry mirroring the vendor credit.
   * @returns {ILedgerEntry[]}
   */
  private get discountEntry(): ILedgerEntry[] {
    const share = this.shares.discount;

    if (!share) {
      return [];
    }
    return [
      {
        ...this.cashEntriesCommonEntry,
        ...debitSide(share),
        accountId: this.purchaseDiscountAccountId,
        accountNormal: AccountNormal.DEBIT,
        index: 1,
      },
    ];
  }

  /**
   * Retrieves the other expenses (adjustment) entry mirroring the vendor
   * credit.
   * @returns {ILedgerEntry[]}
   */
  private get adjustmentEntry(): ILedgerEntry[] {
    const share = this.shares.adjustment;

    if (!share) {
      return [];
    }
    return [
      {
        ...this.cashEntriesCommonEntry,
        ...creditSide(share),
        accountId: this.otherExpensesAccountId,
        accountNormal: AccountNormal.DEBIT,
        index: 1,
      },
    ];
  }

  /**
   * Retrieves the refund vendor credit cash basis GL entries.
   * @returns {ILedgerEntry[]}
   */
  public GLEntries(): ILedgerEntry[] {
    if (this.refundLocalAmount <= 0) {
      return [];
    }
    if (!this.isExpenseReversible()) {
      return [this.refundEntry, this.prepaidExpensesEntry];
    }
    const shares = this.shares;
    const itemsEntries = (this.vendorCredit.entries || []).map((item, index) =>
      this.getVendorCreditItemEntry(item, index, shares.items[index]),
    );
    // A refund above what is left of the vendor credit is a prepaid expense.
    const overAmount = subtractMoney(
      this.refundLocalAmount,
      multiplyMoney(this.recognizedAmount, this.vendorCreditRate),
    );
    const overEntries = moneyGt(overAmount, 0)
      ? [{ ...this.prepaidExpensesEntry, credit: overAmount }]
      : [];

    return balanceEntries(
      [
        this.refundEntry,
        ...this.discountEntry,
        ...this.adjustmentEntry,
        ...itemsEntries,
        ...overEntries,
      ],
      { canAbsorb: (e) => e.itemId !== undefined && e.itemId !== null },
    ).entries;
  }

  /**
   * Retrieves the prepaid expenses credit entry balancing the deposit when
   * the vendor credit has no expense to reverse.
   * @returns {ILedgerEntry}
   */
  private get prepaidExpensesEntry(): ILedgerEntry {
    return {
      ...this.cashEntriesCommonEntry,
      credit: this.refundLocalAmount,
      accountId: this.prepaidExpensesAccountId,
      contactId: this.vendorCredit?.vendorId,
      index: 2,
      accountNormal: AccountNormal.DEBIT,
    };
  }

  /**
   * Retrieves the refund vendor credit cash basis ledger.
   * @returns {Ledger}
   */
  public getLedger = (): Ledger => {
    return new Ledger(this.GLEntries());
  };
}
