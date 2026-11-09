import { useFormikContext } from 'formik';
import { first, pick } from 'lodash';
import moment from 'moment';
import React from 'react';
import { useVendorOpeningBalanceContext } from './VendorOpeningBalanceFormProvider';

/**
 * Vendor opening balance form values.
 *
 * Field names mirror the SDK `EditVendorOpeningBalanceBody` shape
 * (`openingBalance`, `openingBalanceAt`, ...). The submit handler forwards
 * these values directly to `editVendorOpeningBalance`.
 */
export interface VendorOpeningBalanceFormValues {
  openingBalance: string | number;
  openingBalanceBranchId: string | number;
  openingBalanceExchangeRate: number;
  openingBalanceAt: string;
}

/** Vendor-derived seed values pulled out of the vendor record. */
export interface VendorOpeningBalanceSeed {
  id?: number;
  openingBalance?: string | number;
  openingBalanceExchangeRate?: number;
  openingBalanceAt?: string;
  openingBalanceBranchId?: string | number;
  currencyCode?: string;
}

export const useSetPrimaryBranchToForm = () => {
  const { setFieldValue, values } =
    useFormikContext<VendorOpeningBalanceFormValues>();
  const { branches, isBranchesSuccess } = useVendorOpeningBalanceContext();

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

export function transfromVendorToForm(
  values: Partial<VendorOpeningBalanceSeed> | undefined | null,
): VendorOpeningBalanceSeed {
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
