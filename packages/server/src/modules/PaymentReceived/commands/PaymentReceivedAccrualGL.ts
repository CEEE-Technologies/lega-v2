import {
  multiplyMoney,
  roundMoney,
  subtractMoney,
  sumMoney,
  sumMoneyBy,
} from '@bigcapital/utils';
import { ILedgerEntry } from '@/modules/Ledger/types/Ledger.types';
import { PaymentReceived } from '../models/PaymentReceived';
import { AccountNormal } from '@/interfaces/Account';
import { Ledger } from '@/modules/Ledger/Ledger';
import { AccountingBasis } from '@/common/types/AccountingBasis';
import { NO_FOREIGN_AMOUNT } from '@/utils/ledger-rounding';

export class PaymentReceivedAccrualGL {
  private readonly paymentReceived: PaymentReceived;
  private ARAccountId: number;
  private exchangeGainOrLossAccountId: number;
  private baseCurrencyCode: string;
  private paidBefore: Record<number, number> = {};

  /**
   * Constructor method.
   * @param {PaymentReceived} paymentReceived - Payment received.
   */
  constructor(paymentReceived: PaymentReceived) {
    this.paymentReceived = paymentReceived;
  }

  /**
   * Sets what the earlier payments paid on each invoice (invoice currency),
   * for the running-total A/R relief.
   * @param {Record<number, number>} paidBefore - By invoice id.
   */
  setPaidBefore(paidBefore: Record<number, number>) {
    this.paidBefore = paidBefore || {};
    return this;
  }

  /**
   * Sets the A/R account ID.
   * @param {number} ARAccountId - A/R account ID.
   * @returns {PaymentReceivedAccrualGL}
   */
  setARAccountId(ARAccountId: number) {
    this.ARAccountId = ARAccountId;
    return this;
  }

  /**
   * Sets the exchange gain/loss account ID.
   * @param {number} exchangeGainOrLossAccountId - Exchange gain/loss account ID.
   * @returns {PaymentReceivedAccrualGL}
   */
  setExchangeGainOrLossAccountId(exchangeGainOrLossAccountId: number) {
    this.exchangeGainOrLossAccountId = exchangeGainOrLossAccountId;
    return this;
  }

  /**
   * Sets the base currency code.
   * @param {string} baseCurrencyCode - Base currency code.
   * @returns {PaymentReceivedAccrualGL}
   */
  setBaseCurrencyCode(baseCurrencyCode: string) {
    this.baseCurrencyCode = baseCurrencyCode;
    return this;
  }

  /**
   * Calculates the payment total exchange gain/loss.
   * @param   {IBillPayment} paymentReceive - Payment receive with entries.
   * @returns {number}
   */
  private paymentExGainOrLoss = (): number => {
    const entries = this.paymentReceived.entries || [];

    // Difference method: the paid amount at the payment rate and at the
    // invoices' rates are each rounded to cents, and the gain/loss is
    // what is left, so nothing is lost to rounding.
    const paidAtPaymentRate = multiplyMoney(
      sumMoneyBy(entries, 'paymentAmount'),
      this.paymentReceived.exchangeRate,
    );
    const paidAtInvoiceRates = sumMoneyBy(entries, (entry) => {
      // Opening balance lines have no invoice: no exchange difference
      // (foreign currency opening balances are not handled here).
      if (!entry.invoice) {
        return multiplyMoney(
          entry.paymentAmount,
          this.paymentReceived.exchangeRate,
        );
      }
      // The A/R relief at the invoice rate is a running total: (paid so
      // far, this payment included) at the rate less (paid before) at the
      // rate. Rounding each payment alone left a cent on A/R once a
      // foreign currency invoice was paid in parts.
      const rate =
        entry.invoice.exchangeRate ?? this.paymentReceived.exchangeRate;
      const before = this.paidBefore[entry.invoiceId] ?? 0;
      return subtractMoney(
        multiplyMoney(sumMoney(before, entry.paymentAmount), rate),
        multiplyMoney(before, rate),
      );
    });
    return subtractMoney(paidAtPaymentRate, paidAtInvoiceRates);
  };

  /**
   * Retrieves the common entry of payment receive.
   */
  private get paymentReceiveCommonEntry() {
    return {
      debit: 0,
      credit: 0,

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

      basis: AccountingBasis.Accrual,
    };
  }

  /**
   * Retrieves the payment exchange gain/loss entry.
   * @param   {IPaymentReceived} paymentReceive -
   * @param   {number} ARAccountId -
   * @param   {number} exchangeGainOrLossAccountId -
   * @param   {string} baseCurrencyCode -
   * @returns {ILedgerEntry[]}
   */
  private get paymentExchangeGainLossEntry(): ILedgerEntry[] {
    const commonJournal = this.paymentReceiveCommonEntry;
    const gainOrLoss = this.paymentExGainOrLoss();
    const absGainOrLoss = Math.abs(gainOrLoss);

    return gainOrLoss
      ? [
          {
            ...commonJournal,
            currencyCode: this.baseCurrencyCode,
            exchangeRate: 1,
            debit: gainOrLoss > 0 ? absGainOrLoss : 0,
            credit: gainOrLoss < 0 ? absGainOrLoss : 0,
            ...NO_FOREIGN_AMOUNT,
            accountId: this.ARAccountId,
            contactId: this.paymentReceived.customerId,
            index: 3,
            accountNormal: AccountNormal.CREDIT,
          },
          {
            ...commonJournal,
            currencyCode: this.baseCurrencyCode,
            exchangeRate: 1,
            credit: gainOrLoss > 0 ? absGainOrLoss : 0,
            debit: gainOrLoss < 0 ? absGainOrLoss : 0,
            ...NO_FOREIGN_AMOUNT,
            accountId: this.exchangeGainOrLossAccountId,
            index: 3,
            accountNormal: AccountNormal.DEBIT,
          },
        ]
      : [];
  }

  /**
   * Retrieves the payment deposit GL entry.
   * @param {IPaymentReceived} paymentReceive
   * @returns {ILedgerEntry}
   */
  private get paymentDepositGLEntry(): ILedgerEntry {
    const commonJournal = this.paymentReceiveCommonEntry;

    return {
      ...commonJournal,
      debit: roundMoney(this.paymentReceived.localAmount),
      foreignDebit: this.paymentReceived.amount,
      accountId: this.paymentReceived.depositAccountId,
      index: 2,
      accountNormal: AccountNormal.DEBIT,
    };
  }

  /**
   * Retrieves the payment receivable entry.
   * @param   {IPaymentReceived} paymentReceive
   * @param   {number} ARAccountId
   * @returns {ILedgerEntry}
   */
  private get paymentReceivableEntry(): ILedgerEntry {
    const commonJournal = this.paymentReceiveCommonEntry;

    return {
      ...commonJournal,
      credit: roundMoney(this.paymentReceived.localAmount),
      foreignCredit: this.paymentReceived.amount,
      contactId: this.paymentReceived.customerId,
      accountId: this.ARAccountId,
      index: 1,
      accountNormal: AccountNormal.DEBIT,
    };
  }

  /**
   * Records payment receive journal transactions.
   *
   * Invoice payment journals.
   * --------
   * - Account receivable -> Debit
   * - Payment account [current asset] -> Credit
   * @returns {Promise<ILedgerEntry>}
   */
  public GLEntries(): ILedgerEntry[] {
    // Retrieve the payment deposit entry.
    const paymentDepositEntry = this.paymentDepositGLEntry;

    // Retrieves the A/R entry.
    const receivableEntry = this.paymentReceivableEntry;

    // Exchange gain/loss entries.
    const gainLossEntries = this.paymentExchangeGainLossEntry;

    return [paymentDepositEntry, receivableEntry, ...gainLossEntries];
  }

  /**
   * Retrieves the payment receive ledger.
   * @returns {Ledger}
   */
  public getLedger = (): Ledger => {
    return new Ledger(this.GLEntries());
  };
}
