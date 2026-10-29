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
  private exchangeGainOrLossAccountId: number | null = null;
  private accrualLines: Record<number, Record<number, number>> = {};

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
   * Sets the exchange gain/loss account: it takes the currency rounding
   * cent of a foreign currency payment (see balanceCashEntries).
   * @param {number} exchangeGainOrLossAccountId - Account id.
   */
  setExchangeGainOrLossAccountId(exchangeGainOrLossAccountId: number) {
    this.exchangeGainOrLossAccountId = exchangeGainOrLossAccountId;
    return this;
  }

  /**
   * Sets the invoices' accrual lines in the base currency, by invoice id and
   * account (credit positive), as the ledger holds them: posting rounds
   * each converted line and puts the leftover cent on the largest line, so
   * the cash split aims at these to end exactly at them.
   * @param {Record<number, Record<number, number>>} accrualLines
   */
  setAccrualLines(accrualLines: Record<number, Record<number, number>>) {
    this.accrualLines = accrualLines || {};
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
    // The running total in the base currency too: each line's share of
    // everything paid so far, converted and rounded, less the same before
    // this payment. So once fully paid a line ends at its converted amount,
    // like the accrual line (rounding each payment's share alone left a
    // cent off with a foreign rate).
    const paidBefore = this.paidBefore[entry.invoiceId] || 0;
    // At the invoice rate the split runs on the accrual lines themselves, so a
    // fully paid invoice ends at them to the cent, account by account.
    const targets = this.getLineLocalTargets(
      invoice.id,
      defaultTo(invoice.exchangeRate, 1),
      lines,
      [
        ...items.map((item) => item.sellAccountId),
        ...taxedItems.map(() => this.taxPayableAccountId),
        this.discountAccountId,
        this.otherChargesAccountId,
      ],
    );
    const totalLocal = targets ? sumMoney(...targets) : 0;
    const recognizedUpTo = (paid: number) =>
      targets
        ? moneyGte(paid, invoice.total)
          ? targets
          : allocateCumulativeShare(
              0,
              multiplyMoney(paid, exchangeRate),
              totalLocal,
              targets,
            )
        : allocateCumulativeShare(0, paid, invoice.total, lines).map((part) =>
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
   * Retrieves the deposit account (cash/bank) debit entry of the given payment entry.
   * @param {PaymentReceivedEntry} entry - Payment received entry.
   * @returns {ILedgerEntry}
   */
  private getPaymentEntryDepositEntry = (
    entry: PaymentReceivedEntry,
  ): ILedgerEntry => {
    return {
      ...this.cashEntriesCommonEntry,
      debit: this.getBankSplit().entries[this.indexOfEntry(entry)],
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

    return this.balanceCashEntries([
      this.getPaymentEntryDepositEntry(entry),
      ...this.getPaymentEntryIncomeEntries(invoice, shares.items),
      ...this.getPaymentEntryTaxEntries(
        invoice,
        shares.taxedItems,
        shares.taxes,
      ),
      ...this.getPaymentEntryDiscountEntry(shares.discount),
      ...this.getPaymentEntryAdjustmentEntry(shares.adjustment),
    ]);
  };

  /**
   * The base currency amount each line of the invoice ends at once fully paid:
   * the line converted at the invoice rate, with the cent the posting moved
   * (see setAccrualLines) put back on the same account's largest line.
   * Null when the payment rate is not the invoice rate (the cash is then
   * converted at the payment rate) or the accrual lines are unknown.
   */
  private getLineLocalTargets = (
    docId: number,
    docRate: number,
    lines: number[],
    accounts: number[],
  ): number[] | null => {
    const accrual = this.accrualLines[docId];
    const paymentRate = defaultTo(this.paymentReceived.exchangeRate, 1);
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
    // More than rounding: the ledger differs from the invoice; keep the plain
    // conversion.
    return moved <= lines.length
      ? targets
      : lines.map((line) => multiplyMoney(line, docRate));
  };

  /**
   * Balances the cash set of a payment entry. With a foreign rate the
   * converted lines can miss the bank line by a cent: that currency
   * rounding cent goes to exchange gain/loss, as on the accrual side, so
   * every income line still ends at its accrual amount. Without that
   * account the cent goes on the largest income line, never the bank line.
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
      defaultTo(this.paymentReceived.exchangeRate, 1) !== 1 &&
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
    const amount = this.getBankSplit().entries[this.indexOfEntry(entry)];
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
   * Retrieves the payment amount (payment currency). Falls back to the sum of
   * the applied amounts when the payment amount is not set.
   * @returns {number}
   */
  private get paymentAmount(): number {
    return roundMoney(
      defaultTo(
        this.paymentReceived.amount,
        sumBy(this.paymentReceived.entries || [], 'paymentAmount'),
      ),
    );
  }

  /**
   * Retrieves the payment amount in local currency, converted once like the
   * accrual bank line.
   * @returns {number}
   */
  private get paymentLocalAmount(): number {
    return multiplyMoney(
      this.paymentAmount,
      defaultTo(this.paymentReceived.exchangeRate, 1),
    );
  }

  private indexOfEntry = (entry: PaymentReceivedEntry): number =>
    (this.paymentReceived.entries || []).indexOf(entry);

  /**
   * Splits the bank amount of the payment (the payment converted once, as
   * on the accrual side) over its invoice lines, opening balance lines and
   * the excess, in proportion to their payment currency amounts (largest
   * remainder). So the cash basis bank lines add up exactly to the accrual
   * bank line. Converting each part on its own could add up to a cent more
   * or less: USD 0.02 at 1.5 split 0.01 + 0.01 gave 0.02 + 0.02 = 0.04
   * instead of 0.03.
   *
   * A part that is not recognized (zero-total invoice, no opening balance
   * account) is in the excess. When the applied amounts add up to more than
   * the payment (old data), each part keeps its own conversion.
   * @returns {{ entries: number[]; excess: number }} Local amounts, by entry index.
   */
  private getBankSplit = (): { entries: number[]; excess: number } => {
    const entries = this.paymentReceived.entries || [];
    const parts = entries.map((entry) =>
      this.isOpeningBalanceRecognizable(entry)
        ? roundMoney(entry.paymentAmount)
        : this.isIncomeRecognizable(entry)
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
   * Retrieves the deposit amount already posted against invoices.
   * @returns {number}
   */
  public getInvoicesDepositAmount(): number {
    const split = this.getBankSplit();
    return sumMoney(
      ...(this.paymentReceived.entries || []).map((entry, index) =>
        this.isIncomeRecognizable(entry) ? split.entries[index] : 0,
      ),
    );
  }

  /**
   * Retrieves the deposit amount posted against the opening balance.
   * @returns {number}
   */
  public getOpeningBalanceDepositAmount(): number {
    const split = this.getBankSplit();
    return sumMoney(
      ...(this.paymentReceived.entries || []).map((entry, index) =>
        this.isOpeningBalanceRecognizable(entry) ? split.entries[index] : 0,
      ),
    );
  }

  /**
   * Retrieves the payment excess in local currency: its part of the bank
   * amount (see getBankSplit).
   * @returns {number}
   */
  public getExcessAmount(): number {
    return this.getBankSplit().excess;
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
