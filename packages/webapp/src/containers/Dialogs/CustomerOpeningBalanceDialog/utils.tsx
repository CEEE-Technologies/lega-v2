import { useFormikContext } from 'formik';
import { first, pick } from 'lodash';
import moment from 'moment';
import React from 'react';
import { useCustomerOpeningBalanceContext } from './CustomerOpeningBalanceFormProvider';

/**
 * Customer opening balance form values.
 *
 * Field names mirror the SDK `EditCustomerOpeningBalanceBody` shape
 * (`openingBalance`, `openingBalanceAt`, ...). The submit handler forwards
 * these values directly to `editCustomerOpeningBalance`.
 */
export interface CustomerOpeningBalanceFormValues {
  openingBalance: string | number;
  openingBalanceBranchId: string | number;
  openingBalanceExchangeRate: number;
  openingBalanceAt: string;
}

/** Customer-derived seed values pulled out of the customer record. */
export interface CustomerOpeningBalanceSeed {
  id?: number;
  openingBalance?: string | number;
  openingBalanceExchangeRate?: number;
  openingBalanceAt?: string;
  openingBalanceBranchId?: string | number;
  currencyCode?: string;
}

export const useSetPrimaryBranchToForm = () => {
  const { setFieldValue, values } =
    useFormikContext<CustomerOpeningBalanceFormValues>();
  const { branches, isBranchesSuccess } = useCustomerOpeningBalanceContext();

  React.useEffect(() => {
    // Keep the opening balance's own branch; the primary one only if none.
    if (isBranchesSuccess && !values.openingBalanceBranchId) {
      const primaryBranch = branches.find((b) => b.primary) || first(branches);

      if (primaryBranch) {
        setFieldValue('openingBalanceBranchId', primaryBranch.id);
      }
    }
  }, [
    isBranchesSuccess,
    setFieldValue,
    branches,
    values.openingBalanceBranchId,
  ]);
};

export function transfromCustomertoForm(
  values: Partial<CustomerOpeningBalanceSeed> | undefined | null,
): CustomerOpeningBalanceSeed {
  if (!values) {
    return {};
  }
  return {
    ...pick(values, [
      'id',
      'openingBalance',
      'openingBalanceExchangeRate',
      'currencyCode',
    ]),
    // Its own branch, when it has one (null with branches off).
    ...(values.openingBalanceBranchId
      ? { openingBalanceBranchId: values.openingBalanceBranchId }
      : {}),
    // The saved date (the dialog used to show today's, and saving moved
    // the opening balance to it).
    ...(values.openingBalanceAt
      ? {
          openingBalanceAt: moment(values.openingBalanceAt).format(
            'YYYY-MM-DD',
          ),
        }
      : {}),
  };
}
