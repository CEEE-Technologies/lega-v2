import { multiplyMoney, subtractMoney, sumMoney } from '@bigcapital/utils';
import { ILedgerEntry } from '@/modules/Ledger/types/Ledger.types';
import { NO_FOREIGN_AMOUNT } from './ledger-rounding';

/**
 * What a payment (or refund) of `amount` relieves of a document's A/R or
 * A/P, in the base currency, at the document's rate: a running total, the
 * paid so far (this one included) at the rate less the paid before at the
 * rate. Rounding each part alone left a cent on A/R (A/P) once a foreign
 * currency document was settled in parts.
 * @param {number} amount - This payment's amount (document currency).
 * @param {number} before - What the earlier payments paid of the document.
 * @param {number} rate - The document's exchange rate.
 * @returns {number}
 */
export const getRunningTotalRelief = (
  amount: number,
  before: number,
  rate: number,
): number =>
  subtractMoney(
    multiplyMoney(sumMoney(before, amount), rate),
    multiplyMoney(before, rate),
  );

/** Each line's own fields (account, side of the A/R or A/P, index, ...). */
type ILineOptions = Partial<ILedgerEntry> &
  Pick<ILedgerEntry, 'accountId' | 'accountNormal' | 'index'>;

/**
 * The pair of lines that moves an exchange difference between the
 * contact's A/R (A/P) and the exchange gain/loss account, in the base
 * currency, with no foreign amount (the foreign amount of the document
 * stays on the contact's own line).
 *
 * `amount` > 0 debits the contact's account and credits gain/loss; < 0 the
 * other way round. 0 posts nothing.
 * @returns {{ contactEntry: ILedgerEntry; gainLossEntry: ILedgerEntry } | null}
 */
export const getExchangeGainLossEntries = ({
  commonEntry,
  amount,
  baseCurrencyCode,
  contactEntry,
  gainLossEntry,
}: {
  /** The fields both lines take from their transaction (type, id, date...). */
  commonEntry: Partial<ILedgerEntry>;
  amount: number;
  baseCurrencyCode: string;
  contactEntry: ILineOptions;
  gainLossEntry: ILineOptions;
}): { contactEntry: ILedgerEntry; gainLossEntry: ILedgerEntry } | null => {
  if (!amount) return null;

  const abs = Math.abs(amount);
  const base = {
    ...commonEntry,
    currencyCode: baseCurrencyCode,
    exchangeRate: 1,
    ...NO_FOREIGN_AMOUNT,
  };
  return {
    contactEntry: {
      ...base,
      ...contactEntry,
      debit: amount > 0 ? abs : 0,
      credit: amount < 0 ? abs : 0,
    } as ILedgerEntry,
    gainLossEntry: {
      ...base,
      ...gainLossEntry,
      credit: amount > 0 ? abs : 0,
      debit: amount < 0 ? abs : 0,
    } as ILedgerEntry,
  };
};

/**
 * What a refund's accrual journal needs to post its exchange gain/loss:
 * the account, the base currency, and what the earlier refunds took of the
 * document (for the running-total relief).
 */
export interface IRefundExchangeGainLoss {
  exchangeGainOrLossAccountId: number | null;
  baseCurrencyCode: string;
  refundedBefore: number;
}
