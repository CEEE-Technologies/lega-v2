import { useFormikContext } from 'formik';
import React, { createContext, useContext, useEffect } from 'react';
import { usePaymentReceiveFormContext } from './PaymentReceiveFormProvider';
import {
  transformNewPageEntriesToForm,
  type PaymentReceiveFormValues,
} from './utils';
import {
  usePaymentReceiveNewPageEntries,
  type PaymentReceiveNewPageEntry,
} from '@/hooks/query';

interface PaymentReceiveInnerContextValue {
  dueInvoices: PaymentReceiveNewPageEntry[] | undefined;
  isDueInvoicesLoading: boolean;
  isDueInvoicesFetching: boolean;
}

const PaymentReceiveInnerContext = createContext<
  PaymentReceiveInnerContextValue | undefined
>(undefined);

/**
 * Payment receive inner form provider.
 */
function PaymentReceiveInnerProvider({
  ...props
}: {
  children?: React.ReactNode;
}) {
  const { isNewMode } = usePaymentReceiveFormContext();

  const {
    values: { customerId },
    setFieldValue,
  } = useFormikContext<PaymentReceiveFormValues>();

  // The customer's open items: the unpaid opening balance first, then the
  // due invoices.
  const {
    data: dueInvoices,
    isLoading: isDueInvoicesLoading,
    isFetching: isDueInvoicesFetching,
  } = usePaymentReceiveNewPageEntries(customerId, {
    enabled: !!customerId && isNewMode,
  });

  useEffect(() => {
    if (!isDueInvoicesFetching && isNewMode) {
      if (dueInvoices) {
        setFieldValue('entries', transformNewPageEntriesToForm(dueInvoices));
      } else if (!customerId) {
        setFieldValue('entries', []);
      }
    }
  }, [
    isDueInvoicesFetching,
    dueInvoices,
    isNewMode,
    customerId,
    setFieldValue,
  ]);

  const provider: PaymentReceiveInnerContextValue = {
    dueInvoices,
    isDueInvoicesLoading,
    isDueInvoicesFetching,
  };

  return <PaymentReceiveInnerContext.Provider value={provider} {...props} />;
}

const usePaymentReceiveInnerContext = (): PaymentReceiveInnerContextValue => {
  const ctx = useContext(PaymentReceiveInnerContext);
  if (!ctx) {
    throw new Error(
      'usePaymentReceiveInnerContext must be used within a PaymentReceiveInnerProvider',
    );
  }
  return ctx;
};

export { PaymentReceiveInnerProvider, usePaymentReceiveInnerContext };
