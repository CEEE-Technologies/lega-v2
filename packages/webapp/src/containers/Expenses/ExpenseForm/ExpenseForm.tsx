import { moneyGt, sumMoneyBy } from '@bigcapital/utils';
import { Intent } from '@blueprintjs/core';
import { css } from '@emotion/css';
import { Formik, Form, FormikHelpers } from 'formik';
import * as FF from 'fp-ts/function';
import { defaultTo, isEmpty } from 'lodash';
import React, { useMemo } from 'react';
import intl from 'react-intl-universal';
import { useHistory } from 'react-router-dom';
import { ExpenseFloatingFooter } from './ExpenseFloatingActions';
import {
  CreateExpenseFormSchema,
  EditExpenseFormSchema,
} from './ExpenseForm.schema';
import { ExpenseFormBody } from './ExpenseFormBody';
import { ExpenseFormFooter } from './ExpenseFormFooter';
import { ExpenseFormHeader } from './ExpenseFormHeader';
import { useExpenseFormContext } from './ExpenseFormPageProvider';
import { ExpenseFormTopBar } from './ExpenseFormTopBar';
import {
  transformErrors,
  defaultExpense,
  transformToEditForm,
  transformFormValuesToRequest,
} from './utils';
import type { ExpenseErrorResponse, ExpenseFormValues } from './types';
import type { CreateExpenseBody, EditExpenseBody } from '@bigcapital/sdk-ts';
import {
  AppToaster,
  Box,
  DocumentExchangeRateSync,
  useExchangeRateValidate,
} from '@/components';
import { PageForm } from '@/components/PageForm';
import { withDashboardActions } from '@/containers/Dashboard/withDashboardActions';
import { useCurrentOrganizationBaseCurrency } from '@/hooks/query';
import { keepBranchAndWarehouse } from '@/utils/keep-branch-on-reset';

/**
 * Expense form.
 */
function ExpenseFormInner() {
  const baseCurrency = useCurrentOrganizationBaseCurrency();

  const {
    editExpenseMutate,
    createExpenseMutate,
    expense,
    expenseId,
    submitPayloadRef,
    expenseSettings,
  } = useExpenseFormContext();

  const preferredPaymentAccount = parseInt(
    (expenseSettings?.preferredPaymentAccount as string | undefined) ?? '',
    10,
  );

  const isNewMode = !expenseId;

  const history = useHistory();

  const initialValues = useMemo<ExpenseFormValues>(
    () => ({
      ...(!isEmpty(expense)
        ? {
            ...transformToEditForm(expense!, defaultExpense),
          }
        : {
            ...defaultExpense,
            currencyCode: baseCurrency ?? '',
            paymentAccountId: defaultTo(preferredPaymentAccount, ''),
          }),
    }),
    [expense, baseCurrency, preferredPaymentAccount],
  );

  const handleSubmit = (
    values: ExpenseFormValues,
    { setSubmitting, setErrors, resetForm }: FormikHelpers<ExpenseFormValues>,
  ) => {
    setSubmitting(true);
    // In whole cents; a blank row counts as 0 (no text concatenation).
    const totalAmount = sumMoneyBy(values.categories, 'amount');

    if (!moneyGt(totalAmount, 0)) {
      AppToaster.show({
        message: intl.get('amount_cannot_be_zero_or_empty'),
        intent: Intent.DANGER,
      });
      setSubmitting(false);
      return;
    }

    const currentSubmitPayload = submitPayloadRef?.current || {};

    const form = {
      ...transformFormValuesToRequest(values),
      publish: currentSubmitPayload.publish,
    };
    const handleSuccess = () => {
      AppToaster.show({
        message: intl.get(
          isNewMode
            ? 'the_expense_has_been_created_successfully'
            : 'the_expense_has_been_edited_successfully',
          { number: values.paymentAccountId },
        ),
        intent: Intent.SUCCESS,
      });
      setSubmitting(false);

      if (currentSubmitPayload.redirect) {
        history.push('/expenses');
      }
      if (currentSubmitPayload.resetForm) {
        resetForm(keepBranchAndWarehouse(initialValues, values));
      }
    };

    const handleError = ({
      data: { errors },
    }: {
      data: { errors: ExpenseErrorResponse[] };
    }) => {
      transformErrors(errors, { setErrors });
      setSubmitting(false);
    };
    if (isNewMode) {
      createExpenseMutate(form as unknown as CreateExpenseBody)
        .then(handleSuccess)
        .catch(handleError);
    } else {
      editExpenseMutate([expense!.id, form as unknown as EditExpenseBody])
        .then(handleSuccess)
        .catch(handleError);
    }
  };

  // The rate is required for a foreign-currency document.
  const validateExchangeRate = useExchangeRateValidate();

  return (
    <Formik
      validationSchema={
        isNewMode ? CreateExpenseFormSchema : EditExpenseFormSchema
      }
      initialValues={initialValues}
      validate={validateExchangeRate}
      onSubmit={handleSubmit}
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
            <ExpenseFormTopBar />
            <ExpenseFormHeader />

            <Box p="18px 32px 0">
              <ExpenseFormBody />
            </Box>
            <ExpenseFormFooter />
          </PageForm.Body>

          <PageForm.Footer>
            <ExpenseFloatingFooter />
          </PageForm.Footer>
        </PageForm>
      </Form>
    </Formik>
  );
}

export const ExpenseForm = FF.pipe(ExpenseFormInner, withDashboardActions);
