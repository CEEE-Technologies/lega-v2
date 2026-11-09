import {
  amountInAccountCurrency,
  bankAccountNet,
  getMatchPaymentExchangeRate,
  validateUncategorizedTransactionsSameAccount,
} from './_utils';

/**
 * B5 / D4: the payment a match creates for a foreign invoice or bill uses
 * the rate given with the match, never a silent 1.
 */
describe('getMatchPaymentExchangeRate', () => {
  it('pays a base-currency document at 1, whatever rate is sent', () => {
    expect(getMatchPaymentExchangeRate('USD', 'USD')).toBe(1);
    expect(getMatchPaymentExchangeRate('USD', 'USD', 1.3)).toBe(1);
  });

  it('refuses a foreign document without a rate', () => {
    expect(() => getMatchPaymentExchangeRate('EUR', 'USD')).toThrow(
      expect.objectContaining({ errorType: 'EXCHANGE_RATE_REQUIRED' }),
    );
    expect(() => getMatchPaymentExchangeRate('EUR', 'USD', 0)).toThrow(
      expect.objectContaining({ errorType: 'EXCHANGE_RATE_REQUIRED' }),
    );
  });

  it('uses the given rate for a foreign document', () => {
    expect(getMatchPaymentExchangeRate('EUR', 'USD', 1.1)).toBe(1.1);
  });
});

/**
 * A match is compared with what the transaction moves on the bank account,
 * in the account's currency, as its ledger lines post it.
 */
describe('amountInAccountCurrency', () => {
  it('keeps the amount of a transaction in the account currency', () => {
    expect(
      amountInAccountCurrency(
        100,
        { currencyCode: 'EUR', exchangeRate: 1.1 },
        'EUR',
      ),
    ).toBe(100);
  });

  it('converts a foreign transaction on a base-currency account at its rate', () => {
    expect(
      amountInAccountCurrency(
        100,
        { currencyCode: 'EUR', exchangeRate: 1.1 },
        'USD',
      ),
    ).toBe(110);
  });
});

describe('bankAccountNet', () => {
  // Codex review on PR 27: a EUR journal debiting 100 at 1.10 moves USD 110
  // on a USD bank account.
  it('converts a foreign journal to the bank account currency', () => {
    const journal = {
      currencyCode: 'EUR',
      exchangeRate: 1.1,
      entries: [{ debit: 100, credit: 0 }],
    };
    expect(bankAccountNet(journal, 'USD')).toBe(110);
    expect(bankAccountNet(journal, 'EUR')).toBe(100);
  });

  it('nets credits against debits per line', () => {
    const journal = {
      currencyCode: 'EUR',
      exchangeRate: 1.333,
      entries: [
        { debit: 10, credit: 0 },
        { debit: 0, credit: 2.5 },
      ],
    };
    expect(bankAccountNet(journal, 'USD')).toBe(10);
  });
});

describe('validateUncategorizedTransactionsSameAccount', () => {
  it('accepts lines on one account', () => {
    expect(() =>
      validateUncategorizedTransactionsSameAccount([
        { accountId: 1 },
        { accountId: 1 },
      ]),
    ).not.toThrow();
  });

  it('refuses lines on two accounts', () => {
    expect(() =>
      validateUncategorizedTransactionsSameAccount([
        { accountId: 1 },
        { accountId: 2 },
      ]),
    ).toThrow(
      expect.objectContaining({
        errorType: 'UNCATEGORIZED_TRANSACTIONS_ACCOUNTS_DIFFER',
      }),
    );
  });
});
