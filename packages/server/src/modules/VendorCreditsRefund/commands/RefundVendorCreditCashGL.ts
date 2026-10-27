import { defaultTo } from 'lodash';
import { ILedgerEntry } from '@/modules/Ledger/types/Ledger.types';
import { Ledger } from '@/modules/Ledger/Ledger';
import { AccountNormal } from '@/interfaces/Account';
import { AccountingBasis } from '@/common/types/AccountingBasis';
import { ItemEntry } from '@/modules/TransactionItemEntry/models/ItemEntry';
import { RefundVendorCredit } from '../models/RefundVendorCredit';
import { roundLedgerAmount, roundLedgerEntries } from '@/utils/ledger-rounding';

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
  public setPrepaidExpensesAccountId(prepaidExpensesAccountId: number) {
    this.prepaidExpensesAccountId = prepaidExpensesAccountId;
    return this;
  }

  /**
   * Determines whether the refund reverses vendor credit expenses pro-rata.
   * @returns {boolean}
   */
  public isExpenseReversible(): boolean {
    return !!this.vendorCredit && this.refundRatio > 0;
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
   * Retrieves the refunded proportion of the vendor credit.
   * The refund amount over the vendor credit total in local currency keeps
   * the cash basis entries balanced for partial refunds.
   * @returns {number}
   */
  private get refundRatio(): number {
    const vendorCreditTotalLocal = defaultTo(this.vendorCredit?.totalLocal, 0);
    if (vendorCreditTotalLocal <= 0) {
      return 0;
    }
    return this.refundLocalAmount / vendorCreditTotalLocal;
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
  ): ILedgerEntry {
    const commonEntry = this.cashEntriesCommonEntry;
    const exchangeRate = defaultTo(this.vendorCredit?.exchangeRate, 1);

    return {
      ...commonEntry,
      credit: item.totalExcludingTax * exchangeRate * this.refundRatio,
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
    const discountAmountLocal = this.vendorCredit?.discountAmountLocal;

    if (!discountAmountLocal) {
      return [];
    }
    return [
      {
        ...this.cashEntriesCommonEntry,
        debit: discountAmountLocal * this.refundRatio,
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
    const adjustmentLocal = this.vendorCredit?.adjustmentLocal;

    if (!adjustmentLocal) {
      return [];
    }
    const adjustmentAmount = Math.abs(adjustmentLocal) * this.refundRatio;

    return [
      {
        ...this.cashEntriesCommonEntry,
        credit: adjustmentLocal > 0 ? adjustmentAmount : 0,
        debit: adjustmentLocal < 0 ? adjustmentAmount : 0,
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
    const itemsEntries = (this.vendorCredit.entries || []).map((item, index) =>
      this.getVendorCreditItemEntry(item, index),
    );

    return roundLedgerEntries([
      this.refundEntry,
      ...this.discountEntry,
      ...this.adjustmentEntry,
      ...itemsEntries,
    ]);
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
