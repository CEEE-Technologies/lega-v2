import { useFormikContext } from 'formik';
import * as FF from 'fp-ts/function';
import React, { useRef } from 'react';
import { useCreditNoteFormContext } from './CreditNoteFormProvider';
import {
  useCreditNoteIsForeignCustomer,
  useCreditNoteSubtotal,
  type CreditNoteFormValues,
} from './utils';
import type { WithDialogActionsProps } from '@/containers/Dialog/withDialogActions';
import { ExchangeRateInputGroup } from '@/components';
import { DialogsName } from '@/constants/dialogs';
import { withDialogActions } from '@/containers/Dialog/withDialogActions';
import {
  useSyncExRateToForm,
  withExchangeRateFetchingLoading,
  withExchangeRateItemEntriesPriceRecalc,
} from '@/containers/Entries/withExRateItemEntriesPriceRecalc';
import { useCurrentOrganizationBaseCurrency } from '@/hooks/query';
import { useSyncAutoIncrementNumber } from '@/hooks/useSyncAutoIncrementNumber';

type CreditNoteExchangeRateInputFieldRootProps = Omit<
  React.ComponentProps<typeof ExchangeRateInputGroup>,
  'name' | 'fromCurrency' | 'toCurrency'
>;

/**
 * Credit note exchange rate input field.
 */
const CreditNoteExchangeRateInputFieldRoot = ({
  ...props
}: CreditNoteExchangeRateInputFieldRootProps) => {
  const baseCurrency = useCurrentOrganizationBaseCurrency();
  const { values } = useFormikContext<CreditNoteFormValues>();
  const isForeignCustomer = useCreditNoteIsForeignCustomer();

  // Can't continue if the customer is not foreign.
  if (!isForeignCustomer) {
    return null;
  }
  return (
    <ExchangeRateInputGroup
      {...props}
      name={'exchangeRate'}
      fromCurrency={values.currencyCode}
      toCurrency={baseCurrency ?? ''}
      formGroupProps={{ label: ' ', inline: true }}
      withPopoverRecalcConfirm
    />
  );
};

export const CreditNoteExchangeRateInputField = FF.pipe(
  CreditNoteExchangeRateInputFieldRoot,
  withExchangeRateItemEntriesPriceRecalc,
  withExchangeRateFetchingLoading,
);

type CreditNoteSyncIncrementSettingsProps = Record<string, never>;

/**
 * Syncs credit note auto-increment settings to form.
 */
export const CreditNoteSyncIncrementSettingsToForm =
  ({}: CreditNoteSyncIncrementSettingsProps) => {
    const { creditNoteSettings, isNewMode } = useCreditNoteFormContext();
    const creditAutoIncrement = creditNoteSettings?.autoIncrement as
      | boolean
      | undefined;
    const creditNextNumber = creditNoteSettings?.nextNumber as
      | number
      | undefined;
    const creditNumberPrefix = creditNoteSettings?.numberPrefix as
      | string
      | undefined;
    // Editing keeps the credit note's own number; see the hook.
    useSyncAutoIncrementNumber({
      fieldName: 'creditNoteNumber',
      prefix: creditNumberPrefix,
      nextNumber: creditNextNumber,
      autoIncrement: creditAutoIncrement,
      isNewMode,
    });

    return null;
  };

type CreditNoteExchangeRateSyncProps = {
  openDialog: WithDialogActionsProps['openDialog'];
};

/**
 * Syncs the realtime exchange rate to the credit note form and shows up popup to the user
 * as an indication the entries rates have been re-calculated.
 */
export const CreditNoteExchangeRateSync = FF.pipe(
  ({ openDialog }: CreditNoteExchangeRateSyncProps) => {
    const subtotal = useCreditNoteSubtotal();
    const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(
      undefined,
    );

    useSyncExRateToForm({
      onSynced: () => {
        // If the total bigger then zero show alert to the user after adjusting entries.
        if (subtotal > 0) {
          if (timeout.current) clearTimeout(timeout.current);
          timeout.current = setTimeout(() => {
            openDialog(DialogsName.InvoiceExchangeRateChangeNotice);
          }, 500);
        }
      },
    });
    return null;
  },
  withDialogActions,
);
