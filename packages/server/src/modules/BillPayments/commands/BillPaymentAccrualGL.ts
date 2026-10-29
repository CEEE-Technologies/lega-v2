import * as moment from 'moment';
import {
  multiplyMoney,
  roundMoney,
  subtractMoney,
  sumMoney,
  sumMoneyBy,
} from '@bigcapital/utils';
import { BillPayment } from '../models/BillPayment';
import { AccountNormal } from '@/interfaces/Account';
import { ILedgerEntry } from '@/modules/Ledger/types/Ledger.types';
import { Ledger } from '@/modules/Ledger/Ledger';
import { AccountingBasis } from '@/common/types/AccountingBasis';
import { NO_FOREIGN_AMOUNT } from '@/utils/ledger-rounding';

/**
 * Records the accrual basis journal entries of the bill payment.
 * The accrual basis recognizes the payment against the accounts payable
 * (A/P) with any realized exchange gain or loss.
 */
export class BillPaymentAccrualGL {
  private billPayment: BillPayment;
  private APAccountId: number;
  private gainLossAccountId: number;
  private baseCurrency: string;
  private paidBefore: Record<number, number> = {};

  constructor(billPayment: BillPayment) {
    this.billPayment = billPayment;
  }

  /**
   * Sets what the earlier payments paid on each bill (bill currency), for
   * the running-total A/P relief.
   * @param {Record<number, number>} paidBefore - By bill id.
   */
  setPaidBefore(paidBefore: Record<number, number>) {
    this.paidBefore = paidBefore || {};
    return this;
  }

  /**
   * Sets the A/P account ID.
   * @param {number} APAccountId -
   * @returns {BillPaymentAccrualGL}
   */
  setAPAccountId(APAccountId: number) {
    this.APAccountId = APAccountId;
    return this;
  }

  /**
   * Sets the gain/loss account ID.
   * @param {number} gainLossAccountId -
   * @returns {BillPaymentAccrualGL}
   */
  setGainLossAccountId(gainLossAccountId: number) {
    this.gainLossAccountId = gainLossAccountId;
    return this;
  }

  /**
   * Sets the base currency.
   * @param {string} baseCurrency -
   * @returns {BillPaymentAccrualGL}
   */
  setBaseCurrency(baseCurrency: string) {
    this.baseCurrency = baseCurrency;
    return this;
  }

  /**
   * Retrieves the payment common entry.
   */
  private get paymentCommonEntry() {
    const formattedDate = moment(this.billPayment.paymentDate).format(
      'YYYY-MM-DD',
    );

    return {
      debit: 0,
      credit: 0,

      exchangeRate: this.billPayment.exchangeRate,
      currencyCode: this.billPayment.currencyCode,

      transactionId: this.billPayment.id,
      transactionType: 'BillPayment',

      transactionNumber: this.billPayment.paymentNumber,
      referenceNumber: this.billPayment.reference,

      date: formattedDate,
      createdAt: this.billPayment.createdAt,

      branchId: this.billPayment.branchId,

      basis: AccountingBasis.Accrual,
    };
  }

  /**
   * Calculates the payment total exchange gain/loss.
   * @param   {IBillPayment} paymentReceive - Payment receive with entries.
   * @returns {number}
   */
  private get paymentExGainOrLoss(): number {
    const entries = this.billPayment.entries || [];

    // Difference method: the paid amount at the payment rate and at the
    // bills' rates are each rounded to cents, and the gain/loss is what is
    // left, so nothing is lost to rounding.
    const paidAtPaymentRate = multiplyMoney(
      sumMoneyBy(entries, 'paymentAmount'),
      this.billPayment.exchangeRate,
    );
    const paidAtBillRates = sumMoneyBy(entries, (entry) => {
      // Opening balance lines have no bill: no exchange difference
      // (foreign currency opening balances are not handled here).
      if (!entry.bill) {
        return multiplyMoney(
          entry.paymentAmount,
          this.billPayment.exchangeRate,
        );
      }
      // The A/P relief at the bill rate is a running total (see the
      // payment received accrual GL): no cent left once paid in parts.
      const rate = entry.bill.exchangeRate ?? this.billPayment.exchangeRate;
      const before = this.paidBefore[entry.billId] ?? 0;
      return subtractMoney(
        multiplyMoney(sumMoney(before, entry.paymentAmount), rate),
        multiplyMoney(before, rate),
      );
    });
    return subtractMoney(paidAtBillRates, paidAtPaymentRate);
  }

  /**
   * Retrieves the payment exchange gain/loss entries.
   * @returns {ILedgerEntry[]}
   */
  private get paymentExGainOrLossEntries(): ILedgerEntry[] {
    const commonEntry = this.paymentCommonEntry;
    const totalExGainOrLoss = this.paymentExGainOrLoss;
    const absExGainOrLoss = Math.abs(totalExGainOrLoss);

    return totalExGainOrLoss
      ? [
          {
            ...commonEntry,
            currencyCode: this.baseCurrency,
            exchangeRate: 1,
            credit: totalExGainOrLoss > 0 ? absExGainOrLoss : 0,
            debit: totalExGainOrLoss < 0 ? absExGainOrLoss : 0,
            ...NO_FOREIGN_AMOUNT,
            accountId: this.gainLossAccountId,
            index: 2,
            indexGroup: 20,
            accountNormal: AccountNormal.DEBIT,
          },
          {
            ...commonEntry,
            currencyCode: this.baseCurrency,
            exchangeRate: 1,
            debit: totalExGainOrLoss > 0 ? absExGainOrLoss : 0,
            credit: totalExGainOrLoss < 0 ? absExGainOrLoss : 0,
            ...NO_FOREIGN_AMOUNT,
            accountId: this.APAccountId,
            // On the vendor, as the A/R line of a payment received is on
            // the customer: without it the vendor's A/P balance missed
            // every exchange difference.
            contactId: this.billPayment.vendorId,
            index: 3,
            accountNormal: AccountNormal.DEBIT,
          },
        ]
      : [];
  }

  /**
   * Retrieves the payment deposit GL entry.
   * @param   {IBillPayment} billPayment
   * @returns {ILedgerEntry}
   */
  private get paymentGLEntry(): ILedgerEntry {
    const commonEntry = this.paymentCommonEntry;

    return {
      ...commonEntry,
      credit: roundMoney(this.billPayment.localAmount),
      foreignCredit: this.billPayment.amount,
      accountId: this.billPayment.paymentAccountId,
      accountNormal: AccountNormal.DEBIT,
      index: 2,
    };
  }

  /**
   * Retrieves the payment GL payable entry.
   * @returns {ILedgerEntry}
   */
  private get paymentGLPayableEntry(): ILedgerEntry {
    const commonEntry = this.paymentCommonEntry;

    return {
      ...commonEntry,
      exchangeRate: this.billPayment.exchangeRate,
      debit: roundMoney(this.billPayment.localAmount),
      foreignDebit: this.billPayment.amount,
      contactId: this.billPayment.vendorId,
      accountId: this.APAccountId,
      accountNormal: AccountNormal.CREDIT,
      index: 1,
    };
  }

  /**
   * Retrieves the payment GL entries.
   * @param   {IBillPayment} billPayment
   * @param   {number} APAccountId
   * @returns {ILedgerEntry[]}
   */
  private get paymentGLEntries(): ILedgerEntry[] {
    // Retrieves the payment deposit entry.
    const paymentEntry = this.paymentGLEntry;

    // Retrieves the payment debit A/R entry.
    const payableEntry = this.paymentGLPayableEntry;

    // Retrieves the exchange gain/loss entries.
    const exGainLossEntries = this.paymentExGainOrLossEntries;

    return [paymentEntry, payableEntry, ...exGainLossEntries];
  }

  /**
   * Retrieves the bill payment ledger.
   * @param   {IBillPayment} billPayment
   * @param   {number} APAccountId
   * @returns {Ledger}
   */
  public getBillPaymentLedger(): Ledger {
    const entries = this.paymentGLEntries;

    return new Ledger(entries);
  }
}
