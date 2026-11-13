import { Form, useFormikContext } from 'formik';
import React from 'react';
import { RefundCreditNoteFloatingActions } from './RefundCreditNoteFloatingActions';
import { RefundCreditNoteFormFields } from './RefundCreditNoteFormFields';
import { useRefundCreditNoteContext } from './RefundCreditNoteFormProvider';
import type { RefundCreditNoteFormValues } from './types';
import { ForeignExchangeRateSync } from '@/components';

/**
 * Refund credit note form content.
 */
export function RefundCreditNoteFormContent(): React.ReactElement {
  const { creditNote } = useRefundCreditNoteContext();
  const { values } = useFormikContext<RefundCreditNoteFormValues>();

  return (
    <Form>
      {/* The credit note's rate, else today's, never a silent 1. */}
      <ForeignExchangeRateSync
        currencyCode={values.currencyCode}
        isNewMode={true}
        sourceRate={creditNote?.exchangeRate}
      />
      <RefundCreditNoteFormFields />
      <RefundCreditNoteFloatingActions />
    </Form>
  );
}
