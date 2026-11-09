import { Form } from 'formik';
import { useCustomerOpeningBalanceContext } from './CustomerOpeningBalanceFormProvider';
import { DocumentExchangeRateSync, hasOpeningBalance } from '@/components';
import { CustomerOpeningBalanceFields } from './CustomerOpeningBalanceFields';
import { CustomerOpeningBalanceFormFloatingActions } from './CustomerOpeningBalanceFormFloatingActions';

/**
 * Customer Opening balance form content.
 */
export function CustomerOpeningBalanceFormContent() {
  const { customer } = useCustomerOpeningBalanceContext();

  return (
    <Form>
      {/* A first opening balance gets today's rate (or must be typed), not
          the 1 stored with the contact; an existing one keeps its rate. */}
      <DocumentExchangeRateSync
        name={'openingBalanceExchangeRate'}
        isNewMode={!hasOpeningBalance(customer ?? {})}
      />
      <CustomerOpeningBalanceFields />
      <CustomerOpeningBalanceFormFloatingActions />
    </Form>
  );
}
