export interface MatchingTransactionFormValues {
  matched: Record<string, boolean>;
  /** Exchange rate per foreign invoice or bill, keyed like `matched`. */
  exchangeRates: Record<string, number | string>;
}
