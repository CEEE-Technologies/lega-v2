import { getMatchPaymentExchangeRate } from './_utils';

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
