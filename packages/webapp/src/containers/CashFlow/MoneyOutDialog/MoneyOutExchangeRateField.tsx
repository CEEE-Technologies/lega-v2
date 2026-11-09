import { useFormikContext } from 'formik';
import React from 'react';
import { useMoneyOutFieldsContext } from './MoneyOutFieldsProvider';
import { useForeignAccount } from './utils';
import type { MoneyOutFormValues } from './types';
import type { Account } from '@bigcapital/sdk-ts';
import { ExchangeRateMutedField, ForeignExchangeRateSync } from '@/components';

/**
 * Money-out exchange rate field.
 */
export function MoneyOutExchangeRateField() {
  const { values } = useFormikContext<MoneyOutFormValues>();

  const { account } = useMoneyOutFieldsContext();
  const isForeigAccount = useForeignAccount();

  // Cannot continue if the account is not foreign account.
  if (!isForeigAccount) return null;

  return (
    <ExchangeRateMutedField
      name={'exchangeRate'}
      // The amount is in the account's currency and the server books
      // amount × rate in the base currency: 1 {account} = rate {base}.
      fromCurrency={(account as Account | undefined)?.currencyCode}
      toCurrency={values.currencyCode}
      formGroupProps={{ label: '', inline: false }}
      date={values.date}
      exchangeRate={values.exchangeRate}
    />
  );
}

/**
 * Fills the rate for the account's currency: today's rate, else empty (the
 * user must type it), never a silent 1; 1 for a base-currency account.
 */
export function MoneyOutExchangeRateSync() {
  const { account } = useMoneyOutFieldsContext();

  return (
    <ForeignExchangeRateSync
      currencyCode={(account as Account | undefined)?.currencyCode}
      isNewMode={true}
    />
  );
}
