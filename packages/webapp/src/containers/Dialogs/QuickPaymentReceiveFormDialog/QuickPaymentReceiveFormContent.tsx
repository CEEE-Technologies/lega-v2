import { Form, useFormikContext } from 'formik';
import React from 'react';
import { QuickPaymentReceiveFloatingActions } from './QuickPaymentReceiveFloatingActions';
import { QuickPaymentReceiveFormFields } from './QuickPaymentReceiveFormFields';
import { useQuickPaymentReceiveContext } from './QuickPaymentReceiveFormProvider';
import type { QuickPaymentReceiveFormValues } from './types';
import { ForeignExchangeRateSync } from '@/components';

/**
 * Quick payment receive form content.
 */
export function QuickPaymentReceiveFormContent(): React.ReactElement {
  const { invoice } = useQuickPaymentReceiveContext();
  const { values } = useFormikContext<QuickPaymentReceiveFormValues>();

  return (
    <Form>
      {/* The invoice's rate, else today's, never a silent 1. */}
      <ForeignExchangeRateSync
        currencyCode={values.currencyCode}
        isNewMode={true}
        sourceRate={invoice?.exchangeRate}
      />
      <QuickPaymentReceiveFormFields />
      <QuickPaymentReceiveFloatingActions />
    </Form>
  );
}
