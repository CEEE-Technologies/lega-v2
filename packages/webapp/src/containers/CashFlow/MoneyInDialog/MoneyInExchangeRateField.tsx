import { useFormikContext } from 'formik';
import React from 'react';
import { useMoneyInFieldsContext } from './MoneyInFieldsProvider';
import { useForeignAccount } from './utils';
import type { MoneyInFormValues } from './types';
import type { Account } from '@bigcapital/sdk-ts';
import { ExchangeRateMutedField } from '@/components';

export function MoneyInExchangeRateField() {
  const { account } = useMoneyInFieldsContext();
  const { values } = useFormikContext<MoneyInFormValues>();

  const isForeigAccount = useForeignAccount();

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
