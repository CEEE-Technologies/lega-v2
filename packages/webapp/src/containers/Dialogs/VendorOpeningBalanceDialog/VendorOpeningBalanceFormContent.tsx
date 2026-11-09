import { Form } from 'formik';
import { VendorOpeningBalanceFormFields } from './VendorOpeningBalanceFormFields';
import { VendorOpeningBalanceFormFloatingActions } from './VendorOpeningBalanceFormFloatingActions';
import { useVendorOpeningBalanceContext } from './VendorOpeningBalanceFormProvider';
import { DocumentExchangeRateSync, hasOpeningBalance } from '@/components';

/**
 * Vendor Opening balance form content.
 */
export function VendorOpeningBalanceFormContent() {
  const { vendor } = useVendorOpeningBalanceContext();

  return (
    <Form>
      {/* A first opening balance gets today's rate (or must be typed), not
          the 1 stored with the contact; an existing one keeps its rate. */}
      <DocumentExchangeRateSync
        name={'openingBalanceExchangeRate'}
        isNewMode={!hasOpeningBalance(vendor ?? {})}
      />
      <VendorOpeningBalanceFormFields />
      <VendorOpeningBalanceFormFloatingActions />
    </Form>
  );
}
