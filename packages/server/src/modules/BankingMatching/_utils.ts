import { sumMoneyBy, toMoneyNumber } from '@bigcapital/utils';
import * as moment from 'moment';
import * as R from 'ramda';
import { isEmpty } from 'lodash';
import { ERRORS, MatchedTransactionPOJO } from './types';
import { ServiceError } from '../Items/ServiceError';

export const sortClosestMatchTransactions = (
  amount: number,
  date: Date,
  matches: MatchedTransactionPOJO[],
) => {
  return R.sortWith([
    // Sort by amount difference (closest to uncategorized transaction amount first)
    R.ascend((match: MatchedTransactionPOJO) =>
      Math.abs(match.amount - amount),
    ),
    // Sort by date difference (closest to uncategorized transaction date first)
    R.ascend((match: MatchedTransactionPOJO) =>
      Math.abs(moment(match.date).diff(moment(date), 'days')),
    ),
  ])(matches);
};

export const sumMatchTranasctions = (transactions: Array<any>) => {
  // Signed sum in whole cents.
  return sumMoneyBy(transactions, (item) =>
    item.transactionNormal === 'debit'
      ? toMoneyNumber(item.amount)
      : -toMoneyNumber(item.amount),
  );
};

export const sumUncategorizedTransactions = (
  uncategorizedTransactions: Array<any>,
) => {
  return sumMoneyBy(uncategorizedTransactions, 'amount');
};

export const validateUncategorizedTransactionsNotMatched = (
  uncategorizedTransactions: any,
) => {
  const matchedTransactions = uncategorizedTransactions.filter(
    (trans) => !isEmpty(trans.matchedBankTransactions),
  );
  //
  if (matchedTransactions.length > 0) {
    throw new ServiceError(ERRORS.TRANSACTION_ALREADY_MATCHED, '', {
      matchedTransactionsIds: matchedTransactions?.map((m) => m.id),
    });
  }
};

export const validateUncategorizedTransactionsExcluded = (
  uncategorizedTransactions: any,
) => {
  const excludedTransactions = uncategorizedTransactions.filter(
    (trans) => trans.excluded,
  );
  if (excludedTransactions.length > 0) {
    throw new ServiceError(ERRORS.CANNOT_MATCH_EXCLUDED_TRANSACTION, '', {
      excludedTransactionsIds: excludedTransactions.map((e) => e.id),
    });
  }
};

/**
 * The exchange rate of the payment a match creates for an invoice or a bill.
 * A document in the base currency is paid at 1. A foreign one needs the rate
 * the user gave (D4): never a silent 1, which would post the payment at the
 * wrong base amount and a false exchange difference.
 * @param {string} documentCurrency - The invoice or bill currency.
 * @param {string} baseCurrency - The organization base currency.
 * @param {number} exchangeRate - The rate given with the match.
 * @returns {number}
 */
export const getMatchPaymentExchangeRate = (
  documentCurrency: string,
  baseCurrency: string,
  exchangeRate?: number,
): number => {
  if (!documentCurrency || documentCurrency === baseCurrency) {
    return 1;
  }
  if (!exchangeRate || !(exchangeRate > 0)) {
    throw new ServiceError(
      ERRORS.EXCHANGE_RATE_REQUIRED,
      `This document is in ${documentCurrency}. Enter the exchange rate to ${baseCurrency} to match it.`,
      { currencyCode: documentCurrency, baseCurrency },
    );
  }
  return exchangeRate;
};
