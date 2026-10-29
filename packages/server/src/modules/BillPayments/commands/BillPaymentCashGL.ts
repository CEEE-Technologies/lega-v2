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
  allocateMoney,
  balanceEntries,
  fromCents,
  moneyGt,
  moneyGte,
  moneyLt,
  multiplyMoney,
  roundMoney,
  subtractMoney,
  sumMoney,
  toCents,
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
  private exchangeGainOrLossAccountId: number | null = null;
  private accrualLines: Record<number, Record<number, number>> = {};

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
   * Sets the exchange gain/loss account: it takes the currency rounding
   * cent of a foreign currency payment (see balanceCashEntries).
   * @param {number} exchangeGainOrLossAccountId - Account id.
   */
  setExchangeGainOrLossAccountId(exchangeGainOrLossAccountId: number) {
    this.exchangeGainOrLossAccountId = exchangeGainOrLossAccountId;
    return this;
  }

  /**
   * Sets the bills' accrual lines in the base currency, by bill id and
   * account (debit positive), as the ledger holds them: posting rounds
   * each converted line and puts the leftover cent on the largest line, so
   * the cash split aims at these to end exactly at them.
   * @param {Record<number, Record<number, number>>} accrualLines
   */
  setAccrualLines(accrualLines: Record<number, Record<number, number>>) {
    this.accrualLines = accrualLines || {};
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
    // The running total in the base currency too: each line's share of
    // everything paid so far, converted and rounded, less the same before
    // this payment. So once fully paid a line ends at its converted amount,
    // like the accrual line (rounding each payment's share alone left a
    // cent off with a foreign rate).
    const paidBefore = this.paidBefore[entry.billId] || 0;
    // At the bill rate the split runs on the accrual lines themselves, so a
    // fully paid bill ends at them to the cent, account by account.
    const targets = this.getLineLocalTargets(
      bill.id,
      defaultTo(bill.exchangeRate, 1),
      lines,
      [
        ...items.map((item) =>
          ['inventory'].indexOf(item.item?.type) !== -1
            ? item.item.inventoryAccountId
            : item.costAccountId,
        ),
        ...taxedItems.map(() => this.taxPayableAccountId),
        this.purchaseDiscountAccountId,
        this.otherExpensesAccountId,
      ],
    );
    const totalLocal = targets ? sumMoney(...targets) : 0;
    const recognizedUpTo = (paid: number) =>
      targets
        ? moneyGte(paid, bill.total)
          ? targets
          : allocateCumulativeShare(
              0,
              multiplyMoney(paid, exchangeRate),
              totalLocal,
              targets,
            )
        : allocateCumulativeShare(0, paid, bill.total, lines).map((part) =>
            multiplyMoney(part, exchangeRate),
          );
    const before = recognizedUpTo(paidBefore);
    const parts = recognizedUpTo(
      sumMoney(paidBefore, this.getPaymentEntryRecognizedAmount(entry)),
    ).map((part, index) => subtractMoney(part, before[index]));

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
      credit: this.getBankSplit().entries[this.indexOfEntry(entry)],
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

    return this.balanceCashEntries([
      this.getPaymentEntryPaymentAccountEntry(entry),
      ...this.getPaymentEntryItemEntries(bill, shares.items),
      ...this.getPaymentEntryTaxEntries(bill, shares.taxedItems, shares.taxes),
      ...this.getPaymentEntryDiscountEntry(shares.discount),
      ...this.getPaymentEntryAdjustmentEntry(shares.adjustment),
    ]);
  };

  /**
   * The base currency amount each line of the bill ends at once fully paid:
   * the line converted at the bill rate, with the cent the posting moved
   * (see setAccrualLines) put back on the same account's largest line.
   * Null when the payment rate is not the bill rate (the cash is then
   * converted at the payment rate) or the accrual lines are unknown.
   */
  private getLineLocalTargets = (
    docId: number,
    docRate: number,
    lines: number[],
    accounts: number[],
  ): number[] | null => {
    const accrual = this.accrualLines[docId];
    const paymentRate = defaultTo(this.billPayment.exchangeRate, 1);
    if (!accrual || Math.abs(paymentRate - docRate) > 1e-9) return null;

    const targets = lines.map((line) => multiplyMoney(line, docRate));
    const accountIds = [...new Set(accounts)];
    let moved = 0;
    accountIds.forEach((accountId) => {
      const indexes = accounts
        .map((id, index) => (id === accountId ? index : -1))
        .filter((index) => index !== -1);
      const diffCents =
        toCents(accrual[accountId] ?? 0) -
        indexes.reduce((sum, index) => sum + toCents(targets[index]), 0);
      if (diffCents === 0) return;
      moved += Math.abs(diffCents);
      const largest = indexes.reduce((a, b) =>
        Math.abs(targets[b]) > Math.abs(targets[a]) ? b : a,
      );
      targets[largest] = fromCents(toCents(targets[largest]) + diffCents);
    });
    // More than rounding: the ledger differs from the bill; keep the plain
    // conversion.
    return moved <= lines.length
      ? targets
      : lines.map((line) => multiplyMoney(line, docRate));
  };

  /**
   * Balances the cash set of a payment entry. With a foreign rate the
   * converted lines can miss the payment account line by a cent: that currency
   * rounding cent goes to exchange gain/loss, as on the accrual side, so
   * every expense line still ends at its accrual amount. Without that
   * account the cent goes on the largest expense line, never the bank line.
   * @param {ILedgerEntry[]} entries - The cash set of the payment entry.
   * @returns {ILedgerEntry[]}
   */
  private balanceCashEntries = (entries: ILedgerEntry[]): ILedgerEntry[] => {
    const leftoverCents = entries.reduce(
      (sum, e) => sum + toCents(e.debit || 0) - toCents(e.credit || 0),
      0,
    );
    if (
      leftoverCents !== 0 &&
      this.exchangeGainOrLossAccountId &&
      defaultTo(this.billPayment.exchangeRate, 1) !== 1 &&
      Math.abs(leftoverCents) <= entries.length
    ) {
      const amount = fromCents(Math.abs(leftoverCents));
      return [
        ...entries,
        {
          ...this.cashEntriesCommonEntry,
          debit: leftoverCents < 0 ? amount : 0,
          credit: leftoverCents > 0 ? amount : 0,
          accountId: this.exchangeGainOrLossAccountId,
          accountNormal: AccountNormal.DEBIT,
          index: 99,
        },
      ];
    }
    return balanceEntries(entries, {
      canAbsorb: (e) => e.itemId !== undefined && e.itemId !== null,
    }).entries;
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
      // On the payment currency amount, not its conversion: EUR 0.01 at 0.4
      // converts to 0.00, yet three of them pay a EUR 0.03 bill (0.01 base).
      // The running-total split recognizes that cent on the payment where it
      // crosses, balanced by exchange gain/loss.
      moneyGt(this.getPaymentEntryRecognizedAmount(entry), 0)
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
    const amount = this.getBankSplit().entries[this.indexOfEntry(entry)];
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
   * Retrieves the payment amount (payment currency). Falls back to the sum of
   * the applied amounts when the payment amount is not set.
   * @returns {number}
   */
  private get paymentAmount(): number {
    return roundMoney(
      defaultTo(
        this.billPayment.amount,
        sumBy(this.billPayment.entries || [], 'paymentAmount'),
      ),
    );
  }

  /**
   * Retrieves the payment amount in local currency, converted once like the
   * accrual payment account line.
   * @returns {number}
   */
  private get paymentLocalAmount(): number {
    return multiplyMoney(
      this.paymentAmount,
      defaultTo(this.billPayment.exchangeRate, 1),
    );
  }

  private indexOfEntry = (entry: BillPaymentEntry): number =>
    (this.billPayment.entries || []).indexOf(entry);

  /**
   * Splits the payment account amount (the payment converted once, as on
   * the accrual side) over the bill lines, opening balance lines and the
   * excess, in proportion to their payment currency amounts (largest
   * remainder). So the cash basis payment account lines add up exactly to
   * the accrual one. Converting each part on its own could add up to a cent
   * more or less: USD 0.02 at 1.5 split 0.01 + 0.01 gave 0.02 + 0.02 = 0.04
   * instead of 0.03.
   *
   * A part that is not recognized (zero-total bill, no opening balance
   * account) is in the excess. When the applied amounts add up to more than
   * the payment (old data), each part keeps its own conversion.
   * @returns {{ entries: number[]; excess: number }} Local amounts, by entry index.
   */
  private getBankSplit = (): { entries: number[]; excess: number } => {
    const entries = this.billPayment.entries || [];
    const parts = entries.map((entry) =>
      this.isOpeningBalanceRecognizable(entry)
        ? roundMoney(entry.paymentAmount)
        : this.isExpenseRecognizable(entry)
          ? this.getPaymentEntryRecognizedAmount(entry)
          : 0,
    );
    const excess = subtractMoney(this.paymentAmount, sumMoney(...parts));

    if (moneyLt(excess, 0)) {
      return {
        entries: entries.map((entry, index) =>
          parts[index] === 0
            ? 0
            : isOpeningBalanceEntry(entry)
              ? this.getPaymentEntryLocalAmount(entry)
              : this.getPaymentEntryRecognizedLocalAmount(entry),
        ),
        excess: 0,
      };
    }
    const split = allocateMoney(this.paymentLocalAmount, [...parts, excess]);
    return {
      entries: split.slice(0, entries.length),
      excess: split[entries.length],
    };
  };

  /**
   * Retrieves the payment amount already posted against bills.
   * @returns {number}
   */
  public getBillsPaidAmount(): number {
    const split = this.getBankSplit();
    return sumMoney(
      ...(this.billPayment.entries || []).map((entry, index) =>
        this.isExpenseRecognizable(entry) ? split.entries[index] : 0,
      ),
    );
  }

  /**
   * Retrieves the payment amount posted against the opening balance.
   * @returns {number}
   */
  public getOpeningBalancePaidAmount(): number {
    const split = this.getBankSplit();
    return sumMoney(
      ...(this.billPayment.entries || []).map((entry, index) =>
        this.isOpeningBalanceRecognizable(entry) ? split.entries[index] : 0,
      ),
    );
  }

  /**
   * Retrieves the payment excess in local currency: its part of the
   * payment account amount (see getBankSplit).
   * @returns {number}
   */
  public getExcessAmount(): number {
    return this.getBankSplit().excess;
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
