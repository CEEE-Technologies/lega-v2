import { Intent } from '@blueprintjs/core';
import { css } from '@emotion/css';
import { Formik, Form, type FormikHelpers } from 'formik';
import { isEmpty } from 'lodash';
import { useMemo } from 'react';
import intl from 'react-intl-universal';
import { useHistory } from 'react-router-dom';
import { BillFloatingActions } from './BillFloatingActions';
import { EditBillFormSchema, CreateBillFormSchema } from './BillForm.schema';
import { BillFormEntriesActions } from './BillFormEntriesActions';
import { BillFormFooter } from './BillFormFooter';
import { BillFormHeader } from './BillFormHeader';
import { useBillFormContext } from './BillFormProvider';
import { BillFormTopBar } from './BillFormTopBar';
import { BillFormBody as BillItemsEntriesEditor } from './BillItemsEntriesEditor';
import {
  defaultBill,
  filterNonZeroEntries,
  transformToEditForm,
  transformFormValuesToRequest,
  handleErrors,
  type BillFormValues,
} from './utils';
import {
  AppToaster,
  Box,
  DocumentExchangeRateSync,
  useExchangeRateValidate,
} from '@/components';
import { PageForm } from '@/components/PageForm';
import { useCurrentOrganizationBaseCurrency } from '@/hooks/query';
import { safeSumBy } from '@/utils';
import { keepBranchAndWarehouse } from '@/utils/keep-branch-on-reset';

type BillSubmitError = {
  data?: { errors?: { type: string }[] };
};

/**
 * Bill form.
 */
function BillFormInner() {
  const baseCurrency = useCurrentOrganizationBaseCurrency();

  const history = useHistory();

  // Bill form context.
  const { bill, isNewMode, submitPayload, createBillMutate, editBillMutate } =
    useBillFormContext();

  // Initial values in create and edit mode.
  const initialValues = useMemo<BillFormValues>(
    () => ({
      ...(!isEmpty(bill)
        ? transformToEditForm(bill!)
        : {
            ...defaultBill,
            currencyCode: baseCurrency ?? '',
          }),
    }),
    [bill, baseCurrency],
  );

  // Handles form submit.
  const handleFormSubmit = (
    values: BillFormValues,
    { setSubmitting, setErrors, resetForm }: FormikHelpers<BillFormValues>,
  ) => {
    const entries = filterNonZeroEntries(values.entries);
    const totalQuantity = safeSumBy(entries, 'quantity');

    if (totalQuantity === 0) {
      AppToaster.show({
        message: intl.get('quantity_cannot_be_zero_or_empty'),
        intent: Intent.DANGER,
      });
      setSubmitting(false);
      return;
    }
    const form = {
      ...transformFormValuesToRequest(values),
      open: submitPayload.status,
    };
    // Handle the request success.
    const onSuccess = () => {
      AppToaster.show({
        message: intl.get(
          isNewMode
            ? 'the_bill_has_been_created_successfully'
            : 'the_bill_has_been_edited_successfully',
        ),
        intent: Intent.SUCCESS,
      });
      setSubmitting(false);

      if (submitPayload.redirect) {
        history.push('/bills');
      }
      if (submitPayload.resetForm) {
        resetForm(keepBranchAndWarehouse(initialValues, values));
      }
    };
    // Handle the request error.
    const onError = (error: BillSubmitError) => {
      handleErrors(error?.data?.errors ?? [], { setErrors });
      setSubmitting(false);
    };
    if (isNewMode) {
      createBillMutate(form).then(onSuccess).catch(onError);
    } else {
      editBillMutate([bill!.id, form]).then(onSuccess).catch(onError);
    }
  };

  // The rate is required for a foreign-currency document.
  const validateExchangeRate = useExchangeRateValidate();

  return (
    <Formik
      validationSchema={isNewMode ? CreateBillFormSchema : EditBillFormSchema}
      initialValues={initialValues}
      validate={validateExchangeRate}
      onSubmit={handleFormSubmit}
    >
      <Form
        className={css({
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          flex: 1,
        })}
      >
        {/* Fills the rate: never a silent 1 for a foreign currency. */}
        <DocumentExchangeRateSync isNewMode={isNewMode} />
        <PageForm flex={1}>
          <PageForm.Body>
            <BillFormTopBar />
            <BillFormHeader />

            <Box p="18px 32px 0">
              <BillFormEntriesActions />
              <BillItemsEntriesEditor />
            </Box>
            <BillFormFooter />
          </PageForm.Body>

          <PageForm.Footer>
            <BillFloatingActions />
          </PageForm.Footer>
        </PageForm>
      </Form>
    </Formik>
  );
}
export const BillForm = BillFormInner;
