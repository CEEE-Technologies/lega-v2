import { Form, useFormikContext } from 'formik';
import React from 'react';
import { RefundVendorCreditFloatingActions } from './RefundVendorCreditFloatingActions';
import { RefundVendorCreditFormFields } from './RefundVendorCreditFormFields';
import { useRefundVendorCreditContext } from './RefundVendorCreditFormProvider';
import type { RefundVendorCreditFormValues } from './types';
import { ForeignExchangeRateSync } from '@/components';

export function RefundVendorCreditFormContent(): React.ReactElement {
  const { vendorCredit } = useRefundVendorCreditContext();
  const { values } = useFormikContext<RefundVendorCreditFormValues>();

  return (
    <Form>
      {/* The vendor credit's rate, else today's, never a silent 1. */}
      <ForeignExchangeRateSync
        currencyCode={values.currencyCode}
        isNewMode={true}
        sourceRate={vendorCredit?.exchangeRate}
      />
      <RefundVendorCreditFormFields />
      <RefundVendorCreditFloatingActions />
    </Form>
  );
}
