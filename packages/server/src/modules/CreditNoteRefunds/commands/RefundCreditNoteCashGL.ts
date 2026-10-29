import { defaultTo } from 'lodash';
import { ILedgerEntry } from '@/modules/Ledger/types/Ledger.types';
import { Ledger } from '@/modules/Ledger/Ledger';
import { AccountNormal } from '@/interfaces/Account';
import { AccountingBasis } from '@/common/types/AccountingBasis';
import { ItemEntry } from '@/modules/TransactionItemEntry/models/ItemEntry';
import { RefundCreditNote } from '../models/RefundCreditNote';
import {
  allocateCumulativeShare,
  balanceEntries,
  moneyGt,
  roundMoney,
  subtractMoney,
} from '@bigcapital/utils';
import {
  creditSide,
  debitSide,
  roundLedgerAmount,
} from '@/utils/ledger-rounding';

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
   * Amount refunded of the credit note by the earlier refunds: the
   * running-total split starts from there.
   */
  private refundedBefore = 0;

  /**
   * Constructor method.
   * @param {RefundCreditNote} refundCreditNote - Refund credit note.
   */
  constructor(refundCreditNote: RefundCreditNote) {
    this.refundCreditNote = refundCreditNote;
  }

  /**
   * Sets the amount refunded of the credit note by the earlier refunds.
   * @param {number} refundedBefore
   * @returns {RefundCreditNoteCashGL}
   */
  setRefundedBefore(refundedBefore: number) {
    this.refundedBefore = refundedBefore || 0;
    return this;
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
    return (
      !!this.refundCreditNote.creditNote &&
      moneyGt(this.refundCreditNote.creditNote.total, 0) &&
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
   * Retrieves the part of the refund that reverses the credit note income:
   * no more than what the earlier refunds left of the credit note total.
   * Anything above it comes from the customer's unearned revenue.
   * @returns {number}
   */
  private get recognizedAmount(): number {
    const remaining = Math.max(
      subtractMoney(
        defaultTo(this.refundCreditNote.creditNote?.total, 0),
        this.refundedBefore,
      ),
      0,
    );
    return Math.min(roundMoney(this.refundCreditNote.amount), remaining);
  }

  /**
   * Splits the refund over the credit note lines with the running-total
   * method (the lines reversed after this refund minus those reversed
   * before it), so once the credit note is fully refunded every line ends
   * exactly at its amount.
   */
  private get shares() {
    const creditNote = this.refundCreditNote.creditNote;
    const items = creditNote.entries || [];
    const parts = allocateCumulativeShare(
      this.refundedBefore,
      this.recognizedAmount,
      creditNote.total,
      [
        ...items.map((item) => item.totalExcludingTax),
        -defaultTo(creditNote.discountAmount, 0),
        defaultTo(creditNote.adjustment, 0),
      ],
    );
    return {
      items: parts.slice(0, items.length),
      discount: -parts[items.length],
      adjustment: parts[items.length + 1],
    };
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
  private getCreditNoteItemEntry(
    item: ItemEntry,
    index: number,
    share: number,
  ): ILedgerEntry {
    const commonEntry = this.cashEntriesCommonEntry;

    return {
      ...commonEntry,
      ...debitSide(share),
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
    const share = this.shares.discount;

    if (!share) {
      return [];
    }
    return [
      {
        ...this.cashEntriesCommonEntry,
        ...creditSide(share),
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
    const share = this.shares.adjustment;

    if (!share) {
      return [];
    }
    return [
      {
        ...this.cashEntriesCommonEntry,
        ...debitSide(share),
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
    const shares = this.shares;
    const itemsEntries = (creditNote.entries || []).map((item, index) =>
      this.getCreditNoteItemEntry(item, index, shares.items[index]),
    );
    // A refund above what is left of the credit note total comes from the
    // customer's unearned revenue.
    const overAmount = subtractMoney(
      this.refundCreditNote.amount,
      this.recognizedAmount,
    );
    const overEntries = moneyGt(overAmount, 0)
      ? [{ ...this.unearnedRevenueEntry, debit: overAmount }]
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
