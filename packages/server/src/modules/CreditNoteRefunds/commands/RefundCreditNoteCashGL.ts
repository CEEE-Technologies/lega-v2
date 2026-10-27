import { defaultTo } from 'lodash';
import { ILedgerEntry } from '@/modules/Ledger/types/Ledger.types';
import { Ledger } from '@/modules/Ledger/Ledger';
import { AccountNormal } from '@/interfaces/Account';
import { AccountingBasis } from '@/common/types/AccountingBasis';
import { ItemEntry } from '@/modules/TransactionItemEntry/models/ItemEntry';
import { RefundCreditNote } from '../models/RefundCreditNote';
import { roundLedgerAmount, roundLedgerEntries } from '@/utils/ledger-rounding';

/**
 * Records the cash basis journal entries of the credit note refund.
 * The cash basis reverses the income previously recognized on payments
 * when the credit note is actually refunded in cash.
 *
 * The entries mirror the income composition of the credit note (the income
 * accounts, discount, and other charges) scaled by the refunded proportion
 * of the credit note.
 *
 * When the credit note has no income to reverse (zero total or missing), the
 * cash still leaves the bank, so the refund is taken from the customer's
 * unearned revenue instead of dropping the withdrawal line.
 */
export class RefundCreditNoteCashGL {
  private readonly refundCreditNote: RefundCreditNote;

  private discountAccountId: number;
  private adjustmentAccountId: number;
  private unearnedRevenueAccountId: number;

  /**
   * Constructor method.
   * @param {RefundCreditNote} refundCreditNote - Refund credit note.
   */
  constructor(refundCreditNote: RefundCreditNote) {
    this.refundCreditNote = refundCreditNote;
  }

  /**
   * Sets the discount account id.
   * @param {number} discountAccountId - Discount account id.
   * @returns {RefundCreditNoteCashGL}
   */
  setDiscountAccountId(discountAccountId: number) {
    this.discountAccountId = discountAccountId;
    return this;
  }

  /**
   * Sets the other charges (adjustment) account id.
   * @param {number} adjustmentAccountId - Adjustment account id.
   * @returns {RefundCreditNoteCashGL}
   */
  setAdjustmentAccountId(adjustmentAccountId: number) {
    this.adjustmentAccountId = adjustmentAccountId;
    return this;
  }

  /**
   * Sets the unearned revenue account id, debited when the credit note has
   * no income to reverse.
   * @param {number} unearnedRevenueAccountId - Unearned revenue account id.
   * @returns {RefundCreditNoteCashGL}
   */
  setUnearnedRevenueAccountId(unearnedRevenueAccountId: number) {
    this.unearnedRevenueAccountId = unearnedRevenueAccountId;
    return this;
  }

  /**
   * Determines whether the refund reverses credit note income pro-rata.
   * @returns {boolean}
   */
  public isIncomeReversible(): boolean {
    return !!this.refundCreditNote.creditNote && this.refundRatio > 0;
  }

  /**
   * Retrieves the common journal entry of the cash basis entries.
   */
  private get cashEntriesCommonEntry() {
    return {
      credit: 0,
      debit: 0,

      currencyCode: this.refundCreditNote.currencyCode,
      exchangeRate: this.refundCreditNote.exchangeRate,

      transactionId: this.refundCreditNote.id,
      transactionType: 'RefundCreditNote',

      referenceNumber: this.refundCreditNote.referenceNo,

      date: this.refundCreditNote.date,
      createdAt: this.refundCreditNote.createdAt,

      note: this.refundCreditNote.description,
      branchId: this.refundCreditNote.branchId,

      indexGroup: 50,

      basis: AccountingBasis.Cash,
    };
  }

  /**
   * Retrieves the refunded proportion of the credit note.
   * The refund amount over the credit note total in local currency keeps
   * the cash basis entries balanced for partial refunds.
   * @returns {number}
   */
  private get refundRatio(): number {
    const creditNoteTotalLocal = defaultTo(
      this.refundCreditNote.creditNote?.totalLocal,
      0,
    );

    if (creditNoteTotalLocal <= 0) {
      return 0;
    }
    return this.refundCreditNote.amount / creditNoteTotalLocal;
  }

  /**
   * Retrieves the withdrawal account (cash/bank) credit entry.
   * @returns {ILedgerEntry}
   */
  private get refundEntry(): ILedgerEntry {
    return {
      ...this.cashEntriesCommonEntry,
      credit: roundLedgerAmount(this.refundCreditNote.amount),
      accountId: this.refundCreditNote.fromAccountId,
      index: 1,
      accountNormal: AccountNormal.DEBIT,
    };
  }

  /**
   * Retrieves the cash basis entry of the given credit note item.
   * @param {ItemEntry} item - Credit note item entry.
   * @param {number} index - Item entry index.
   * @returns {ILedgerEntry}
   */
  private getCreditNoteItemEntry(item: ItemEntry, index: number): ILedgerEntry {
    const commonEntry = this.cashEntriesCommonEntry;
    const exchangeRate = defaultTo(
      this.refundCreditNote.creditNote?.exchangeRate,
      1,
    );

    return {
      ...commonEntry,
      debit: item.totalExcludingTax * exchangeRate * this.refundRatio,
      accountId: item.sellAccountId || item.item.sellAccountId,
      note: item.description,
      index: index + 2,
      itemId: item.itemId,
      accountNormal: AccountNormal.CREDIT,
    };
  }

  /**
   * Retrieves the discount entry mirroring the credit note discount.
   * @returns {ILedgerEntry[]}
   */
  private get discountEntry(): ILedgerEntry[] {
    const discountAmountLocal =
      this.refundCreditNote.creditNote?.discountAmountLocal;

    if (!discountAmountLocal) {
      return [];
    }
    return [
      {
        ...this.cashEntriesCommonEntry,
        credit: discountAmountLocal * this.refundRatio,
        accountId: this.discountAccountId,
        accountNormal: AccountNormal.CREDIT,
        index: 1,
      },
    ];
  }

  /**
   * Retrieves the other charges (adjustment) entry mirroring the credit note.
   * @returns {ILedgerEntry[]}
   */
  private get adjustmentEntry(): ILedgerEntry[] {
    const adjustmentLocal = this.refundCreditNote.creditNote?.adjustmentLocal;

    if (!adjustmentLocal) {
      return [];
    }
    const adjustmentAmount = Math.abs(adjustmentLocal) * this.refundRatio;

    return [
      {
        ...this.cashEntriesCommonEntry,
        credit: adjustmentLocal < 0 ? adjustmentAmount : 0,
        debit: adjustmentLocal > 0 ? adjustmentAmount : 0,
        accountId: this.adjustmentAccountId,
        accountNormal: AccountNormal.CREDIT,
        index: 1,
      },
    ];
  }

  /**
   * Retrieves the refund credit note cash basis GL entries.
   * @returns {ILedgerEntry[]}
   */
  public GLEntries(): ILedgerEntry[] {
    if (roundLedgerAmount(this.refundCreditNote.amount) <= 0) {
      return [];
    }
    if (!this.isIncomeReversible()) {
      return [this.refundEntry, this.unearnedRevenueEntry];
    }
    const creditNote = this.refundCreditNote.creditNote;
    const itemsEntries = (creditNote.entries || []).map((item, index) =>
      this.getCreditNoteItemEntry(item, index),
    );

    return roundLedgerEntries([
      this.refundEntry,
      ...this.discountEntry,
      ...this.adjustmentEntry,
      ...itemsEntries,
    ]);
  }

  /**
   * Retrieves the unearned revenue debit entry balancing the withdrawal when
   * the credit note has no income to reverse.
   * @returns {ILedgerEntry}
   */
  private get unearnedRevenueEntry(): ILedgerEntry {
    return {
      ...this.cashEntriesCommonEntry,
      debit: roundLedgerAmount(this.refundCreditNote.amount),
      accountId: this.unearnedRevenueAccountId,
      contactId: this.refundCreditNote.creditNote?.customerId,
      index: 2,
      accountNormal: AccountNormal.CREDIT,
    };
  }

  /**
   * Retrieves the refund credit note cash basis ledger.
   * @returns {Ledger}
   */
  public getLedger = (): Ledger => {
    return new Ledger(this.GLEntries());
  };
}
