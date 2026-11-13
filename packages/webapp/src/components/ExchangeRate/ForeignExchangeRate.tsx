import { useFormikContext } from 'formik';
import { useCallback, useEffect, useRef, useState } from 'react';
import intl from 'react-intl-universal';
import {
  useCurrentOrganizationBaseCurrency,
  useLatestExchangeRate,
} from '@/hooks/query';

/**
 * Whether the given currency is foreign: set, and not the base currency.
 */
export const isForeignCurrency = (
  currencyCode: string | null | undefined,
  baseCurrency: string | null | undefined,
): boolean =>
  Boolean(currencyCode) &&
  Boolean(baseCurrency) &&
  currencyCode !== baseCurrency;

/** Whether the value is a usable rate: a number above 0. */
export const isValidExchangeRate = (value: unknown): boolean => {
  if (value === '' || value === null || value === undefined) return false;
  const rate = Number(value);
  return Number.isFinite(rate) && rate > 0;
};

/**
 * Formik `validate` for the exchange rate: required (above 0) when the
 * document's currency is foreign. The server books `amount × rate`, so a
 * missing rate would otherwise post at 1.
 * @param getCurrency - The foreign currency of the form (the document's
 *   currency, or the bank account's for money in/out).
 * @param name - The rate field.
 * @param when - Only then is the rate needed (e.g. an opening balance is set).
 */
export const useExchangeRateValidate = <V,>(
  getCurrency: (values: V) => string | null | undefined = (values) =>
    (values as { currencyCode?: string }).currencyCode,
  name = 'exchangeRate',
  when?: (values: V) => boolean,
) => {
  const baseCurrency = useCurrentOrganizationBaseCurrency();
  // The latest `getCurrency` (it may read data loaded after the first render).
  const getCurrencyRef = useRef(getCurrency);
  getCurrencyRef.current = getCurrency;
  const whenRef = useRef(when);
  whenRef.current = when;

  return useCallback(
    (values: V) => {
      const rate = (values as Record<string, unknown>)[name];
      if (whenRef.current && !whenRef.current(values)) return {};
      if (
        isForeignCurrency(getCurrencyRef.current(values), baseCurrency) &&
        !isValidExchangeRate(rate)
      ) {
        return { [name]: intl.get('exchange_rate.error.required') };
      }
      return {};
    },
    [baseCurrency, name],
  );
};

interface ForeignExchangeRateSyncProps {
  /** The form's foreign currency (the document's, or the bank account's). */
  currencyCode: string | null | undefined;
  /** A new document fills the rate when it opens; an edit keeps its rate. */
  isNewMode: boolean;
  /** The rate of the document being paid or refunded, used before the latest rate. */
  sourceRate?: number | string | null;
  /** The rate field. */
  name?: string;
  /** Called when the rate is filled (e.g. to re-price entries). */
  onRateFilled?: (rate: number | '', oldRate: unknown) => void;
}

/**
 * Fills a form's exchange rate so it is never a silent 1:
 *
 * - the base currency: 1;
 * - a foreign currency, on a new document or when the currency changes:
 *   the source document's rate when given, else today's rate from the
 *   rate service, else empty (the user must type it);
 * - editing a document keeps its saved rate until the currency changes.
 *
 * Renders nothing; put it inside the Formik form.
 */
export function ForeignExchangeRateSync({
  currencyCode,
  isNewMode,
  sourceRate,
  name = 'exchangeRate',
  onRateFilled,
}: ForeignExchangeRateSyncProps) {
  const { values, setFieldValue } = useFormikContext<Record<string, unknown>>();
  const baseCurrency = useCurrentOrganizationBaseCurrency();
  const currentRate = values[name];

  // The currency the rate was last filled for; undefined until the first
  // fill. An edit starts as already filled for its saved currency.
  const filledFor = useRef<string | null | undefined>(
    isNewMode ? undefined : (currencyCode ?? null),
  );
  // The currency to fetch the latest rate for, when there's no source rate.
  const [fetchCurrency, setFetchCurrency] = useState<string | null>(null);

  const {
    data: latest,
    isFetching,
    isError,
  } = useLatestExchangeRate(
    { fromCurrency: fetchCurrency ?? undefined },
    {
      enabled: Boolean(fetchCurrency),
      refetchOnWindowFocus: false,
      staleTime: 0,
      gcTime: 0,
      retry: 0,
    },
  );

  const fill = useCallback(
    (rate: number | '') => {
      if (rate === currentRate) return;
      setFieldValue(name, rate);
      onRateFilled?.(rate, currentRate);
    },
    [currentRate, name, onRateFilled, setFieldValue],
  );

  // Fill when the form opens (new documents) or the currency changes.
  useEffect(() => {
    // Wait until both currencies are known.
    if (!baseCurrency || currencyCode === undefined) return;
    if (filledFor.current === currencyCode) return;
    const isFirstFill = filledFor.current === undefined;
    filledFor.current = currencyCode;

    // Remounted over a rate the user already typed (money in/out remount
    // their fields when the type changes): keep it. 1 is the forms' default
    // for a foreign currency, so it is still replaced.
    if (
      isFirstFill &&
      isForeignCurrency(currencyCode, baseCurrency) &&
      isValidExchangeRate(currentRate) &&
      Number(currentRate) !== 1 &&
      !isValidExchangeRate(sourceRate)
    ) {
      return;
    }
    if (!isForeignCurrency(currencyCode, baseCurrency)) {
      setFetchCurrency(null);
      fill(1);
      return;
    }
    if (isValidExchangeRate(sourceRate)) {
      setFetchCurrency(null);
      fill(Number(sourceRate));
      return;
    }
    // Shown empty while fetching; filled when the rate comes back.
    fill('');
    setFetchCurrency(currencyCode ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseCurrency, currencyCode, sourceRate]);

  // The latest rate came back (or failed: the field stays empty).
  useEffect(() => {
    if (!fetchCurrency || isFetching) return;
    if (fetchCurrency !== currencyCode) return;
    const rate = latest?.exchangeRate;
    // Only into the still-empty field: a rate typed while the request was
    // in flight wins.
    if (!isError && isValidExchangeRate(rate) && currentRate === '') {
      fill(Number(rate));
    }
    setFetchCurrency(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchCurrency, isFetching, isError, latest?.exchangeRate]);

  return null;
}

/**
 * `ForeignExchangeRateSync` for a document whose currency is its
 * `currencyCode` value (bills, payments, expenses, journals…).
 */
export function DocumentExchangeRateSync({
  isNewMode,
  sourceRate,
  name,
}: {
  isNewMode: boolean;
  sourceRate?: number | string | null;
  name?: string;
}) {
  const { values } = useFormikContext<{ currencyCode?: string }>();

  return (
    <ForeignExchangeRateSync
      currencyCode={values.currencyCode}
      isNewMode={isNewMode}
      sourceRate={sourceRate}
      name={name}
    />
  );
}

/** An opening balance needs its rate only when there is a balance. */
export const hasOpeningBalance = (values: { openingBalance?: unknown }) =>
  Number(values.openingBalance) > 0;
