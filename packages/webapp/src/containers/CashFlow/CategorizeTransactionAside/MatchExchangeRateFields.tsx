import { ControlGroup, Spinner } from '@blueprintjs/core';
import { getIn, useFormikContext } from 'formik';
import React, { useEffect, useRef } from 'react';
import styled from 'styled-components';
import { useMatchingTransactionBoot } from './MatchingTransactionBoot';
import type { MatchingTransactionFormValues } from './types';
import { FFormGroup, FMoneyInputGroup, Stack } from '@/components';
import {
  useCurrentOrganizationBaseCurrency,
  useLatestExchangeRate,
} from '@/hooks/query';

/** Match types that create a payment, so a foreign one needs a rate. */
const PAYMENT_MATCH_TYPES = ['SaleInvoice', 'Bill'];

export interface MatchCurrencyItem {
  referenceType: string;
  referenceId: number;
  transactionNo?: string;
  currencyCode?: string;
  exchangeRate?: number;
}

export const matchKey = (match: {
  referenceType: string;
  referenceId: number;
}) => `${match.referenceType}-${match.referenceId}`;

/**
 * Whether matching the given document needs an exchange rate: an invoice or
 * bill (the match pays it) not in the base currency.
 */
export const isForeignPaymentMatch = (
  match: MatchCurrencyItem,
  baseCurrency?: string,
) =>
  PAYMENT_MATCH_TYPES.includes(match.referenceType) &&
  Boolean(match.currencyCode) &&
  Boolean(baseCurrency) &&
  match.currencyCode !== baseCurrency;

/**
 * Selected matches that need an exchange rate.
 */
export function useSelectedForeignMatches(): MatchCurrencyItem[] {
  const { values } = useFormikContext<MatchingTransactionFormValues>();
  const { matches } = useMatchingTransactionBoot();
  const baseCurrency = useCurrentOrganizationBaseCurrency();

  return (matches as MatchCurrencyItem[]).filter(
    (match) =>
      values.matched[matchKey(match)] &&
      isForeignPaymentMatch(match, baseCurrency),
  );
}

/**
 * Renders an exchange rate field for each selected invoice or bill in
 * another currency than the base currency (D4: never a silent 1).
 */
export function MatchExchangeRateFields() {
  const foreignMatches = useSelectedForeignMatches();

  if (foreignMatches.length === 0) return null;

  return (
    <Root spacing={8}>
      <Title>Exchange rate</Title>
      {foreignMatches.map((match) => (
        <MatchExchangeRateField key={matchKey(match)} match={match} />
      ))}
    </Root>
  );
}

/**
 * One rate field, pre-filled with the latest rate, or the document's own
 * rate when the rate provider has none.
 */
function MatchExchangeRateField({ match }: { match: MatchCurrencyItem }) {
  const baseCurrency = useCurrentOrganizationBaseCurrency();
  const { values, setFieldValue } =
    useFormikContext<MatchingTransactionFormValues>();
  const name = `exchangeRates.${matchKey(match)}`;
  const value = getIn(values, name);

  const { data, isLoading } = useLatestExchangeRate(
    { fromCurrency: match.currencyCode, toCurrency: baseCurrency },
    {
      enabled: Boolean(match.currencyCode && baseCurrency),
      refetchOnWindowFocus: false,
      retry: 0,
    },
  );

  // Pre-fill once, without overwriting what the user typed (or cleared).
  const prefilled = useRef(value !== undefined && value !== '');
  useEffect(() => {
    if (prefilled.current || isLoading) return;
    const latest = data?.exchangeRate;
    const rate =
      latest && latest > 0
        ? latest
        : match.exchangeRate && match.exchangeRate > 0
          ? match.exchangeRate
          : null;
    prefilled.current = true;
    if (rate) setFieldValue(name, rate);
  }, [data, isLoading, match.exchangeRate, name, setFieldValue]);

  return (
    <FFormGroup
      name={name}
      label={match.transactionNo || matchKey(match)}
      inline
      fastField={false}
    >
      <ControlGroup>
        <Side>1 {match.currencyCode} =</Side>
        <RateInput
          name={name}
          allowDecimals
          decimalsLimit={6}
          rightElement={isLoading ? <Spinner size={14} /> : undefined}
        />
        <Side>{baseCurrency}</Side>
      </ControlGroup>
    </FFormGroup>
  );
}

const Root = styled(Stack)`
  padding: 12px 15px;
  border-top: 1px solid var(--color-matching-transaction-border, #e1e8ed);
`;

const Title = styled.h3`
  font-size: 13px;
  font-weight: 600;
  margin: 0;
`;

const Side = styled.div`
  display: flex;
  align-items: center;
  font-size: 12px;
  padding: 0 8px;
  white-space: nowrap;
`;

const RateInput = styled(FMoneyInputGroup)`
  max-width: 100px;
`;
