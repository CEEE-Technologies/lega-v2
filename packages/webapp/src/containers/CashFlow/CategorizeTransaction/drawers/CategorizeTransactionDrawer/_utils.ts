import { toNumber } from 'lodash';
import { useCategorizeTransactionBoot } from './CategorizeTransactionBoot';
import type { GetAutofillCategorizeTransaction } from '@/hooks/query/banking';
import type { CategorizeTransactionBody } from '@bigcapital/sdk-ts';
import { transformToForm } from '@/utils';

export interface CategorizeTransactionFormValues {
  amount: string;
  date: string;
  creditAccountId: string;
  debitAccountId: string;
  exchangeRate: string;
  transactionType: string;
  referenceNo: string;
  description: string;
  branchId: string | number | null;
}

// Default initial form values.
export const defaultInitialValues: CategorizeTransactionFormValues = {
  amount: '',
  date: '',
  creditAccountId: '',
  debitAccountId: '',
  exchangeRate: '1',
  transactionType: '',
  referenceNo: '',
  description: '',
  branchId: '',
};

export const transformToCategorizeForm = (
  autofillCategorizeTransaction:
    | GetAutofillCategorizeTransaction
    | null
    | undefined,
) => {
  return transformToForm(autofillCategorizeTransaction, defaultInitialValues);
};

export const tranformToRequest = (
  formValues: CategorizeTransactionFormValues,
  uncategorizedTransactionIds: Array<number>,
): CategorizeTransactionBody => {
  return {
    date: formValues.date,
    creditAccountId: toNumber(formValues.creditAccountId) ?? 0,
    referenceNo: formValues.referenceNo,
    transactionType: formValues.transactionType,
    // Required (and checked) for a foreign-currency bank account; the
    // server uses 1 for a base-currency one.
    // (The SDK body type still marks it required, from the old default 1.)
    exchangeRate: (Number(formValues.exchangeRate) || undefined) as number,
    description: formValues.description,
    branchId: toNumber(formValues.branchId),
    uncategorizedTransactionIds,
  };
};

/**
 * The currency of the bank account being categorized: the line's amount is
 * in it, and the books get amount × rate in the base currency.
 */
export const useCategorizeBankAccountCurrency = () => {
  const { accounts } = useCategorizeTransactionBoot();

  return (bankAccountId: string | number | null | undefined) =>
    (
      accounts as Array<{ id: number; currencyCode?: string }> | undefined
    )?.find((account) => account.id === Number(bankAccountId))?.currencyCode;
};

/**
 * Categorize transaction form initial values.
 */
export const useCategorizeTransactionFormInitialValues =
  (): CategorizeTransactionFormValues => {
    const { primaryBranch, autofillCategorizeValues } =
      useCategorizeTransactionBoot();

    return {
      ...defaultInitialValues,
      /**
       * We only care about the fields in the form. Previously unfilled optional
       * values such as `notes` come back from the API as null, so remove those
       * as well.
       */
      ...transformToCategorizeForm(autofillCategorizeValues),

      /** Assign the primary branch id as default value. */
      branchId: primaryBranch?.id || null,
    };
  };
