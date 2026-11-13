import { Form, useFormikContext } from 'formik';
import React from 'react';
import { QuickPaymentMadeFloatingActions } from './QuickPaymentMadeFloatingActions';
import { QuickPaymentMadeFormFields } from './QuickPaymentMadeFormFields';
import { useQuickPaymentMadeContext } from './QuickPaymentMadeFormProvider';
import type { QuickPaymentMadeFormValues } from './types';
import { ForeignExchangeRateSync } from '@/components';
/**
 * Quick payment made form content.
 */
export function QuickPaymentMadeFormContent(): React.ReactElement {
  const { bill } = useQuickPaymentMadeContext();
  const { values } = useFormikContext<QuickPaymentMadeFormValues>();

  return (
    <Form>
      {/* The bill's rate, else today's, never a silent 1. */}
      <ForeignExchangeRateSync
        currencyCode={values.currencyCode}
        isNewMode={true}
        sourceRate={bill?.exchangeRate}
      />
      <QuickPaymentMadeFormFields />
      <QuickPaymentMadeFloatingActions />
    </Form>
  );
}
