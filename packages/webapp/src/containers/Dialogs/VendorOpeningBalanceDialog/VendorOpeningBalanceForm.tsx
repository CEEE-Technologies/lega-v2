import { Intent } from '@blueprintjs/core';
import { Formik, FormikHelpers } from 'formik';
import * as FF from 'fp-ts/function';
import { defaultTo } from 'lodash';
import moment from 'moment';
import intl from 'react-intl-universal';
import { CreateVendorOpeningBalanceFormSchema } from './VendorOpeningBalanceForm.schema';
import { VendorOpeningBalanceFormContent } from './VendorOpeningBalanceFormContent';
import { useVendorOpeningBalanceContext } from './VendorOpeningBalanceFormProvider';
import type { VendorOpeningBalanceFormValues } from './utils';
import type { WithDialogActionsProps } from '@/containers/Dialog/withDialogActions';
import { AppToaster } from '@/components';
import { withDialogActions } from '@/containers/Dialog/withDialogActions';

const defaultInitialValues: VendorOpeningBalanceFormValues = {
  openingBalance: '0',
  openingBalanceBranchId: '',
  openingBalanceExchangeRate: 1,
  openingBalanceAt: moment(new Date()).format('YYYY-MM-DD'),
};

interface VendorOpeningBalanceFormProps extends WithDialogActionsProps {}

/**
 * Vendor Opening balance form.
 */
function VendorOpeningBalanceFormInner({
  closeDialog,
}: VendorOpeningBalanceFormProps) {
  const { dialogName, vendor, editVendorOpeningBalanceMutate } =
    useVendorOpeningBalanceContext();

  // Initial form values
  const initialValues: VendorOpeningBalanceFormValues = {
    ...defaultInitialValues,
    ...vendor,
    openingBalance: defaultTo(vendor.openingBalance, ''),
  };

  // Handles the form submit.
  const handleFormSubmit = (
    values: VendorOpeningBalanceFormValues,
    { setSubmitting }: FormikHelpers<VendorOpeningBalanceFormValues>,
  ) => {
    const formValues = {
      openingBalance: Number(values.openingBalance),
      openingBalanceAt: moment(values.openingBalanceAt).format('YYYY-MM-DD'),
      openingBalanceExchangeRate: values.openingBalanceExchangeRate,
      openingBalanceBranchId: values.openingBalanceBranchId
        ? Number(values.openingBalanceBranchId)
        : undefined,
    };

    // Handle request response success.
    const onSuccess = () => {
      AppToaster.show({
        message: intl.get('vendor_opening_balance.success_message'),
        intent: Intent.SUCCESS,
      });
      closeDialog(dialogName);
    };

    // Handle request response errors.
    const onError = (error: {
      data?: { errors?: { type?: string; message?: string }[] };
    }) => {
      const errors = error?.data?.errors;
      const belowPaid = Array.isArray(errors)
        ? errors.find((e) => e.type === 'OPENING_BALANCE_BELOW_PAID')
        : null;

      // The opening balance can't go below what payments already paid.
      if (belowPaid) {
        AppToaster.show({
          message:
            belowPaid.message ||
            'Payments already paid part of this opening balance; it can not be set below that amount.',
          intent: Intent.DANGER,
        });
      }
      setSubmitting(false);
    };

    editVendorOpeningBalanceMutate([vendor.id!, formValues])
      .then(onSuccess)
      .catch(onError);
  };

  return (
    <Formik<VendorOpeningBalanceFormValues>
      validationSchema={CreateVendorOpeningBalanceFormSchema}
      initialValues={initialValues}
      onSubmit={handleFormSubmit}
      component={VendorOpeningBalanceFormContent}
    />
  );
}
export const VendorOpeningBalanceForm = FF.pipe(
  VendorOpeningBalanceFormInner,
  withDialogActions,
);
