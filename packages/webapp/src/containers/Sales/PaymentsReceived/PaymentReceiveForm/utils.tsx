import { Intent } from '@blueprintjs/core';
import { useFormikContext } from 'formik';
import { omit, pick, first } from 'lodash';
import moment from 'moment';
import React from 'react';
import intl from 'react-intl-universal';
import { usePaymentReceiveFormContext } from './PaymentReceiveFormProvider';
import { AppToaster } from '@/components';
import {
  transformAttachmentsToForm,
  transformAttachmentsToRequest,
} from '@/containers/Attachments/utils';
import { convertBrandingTemplatesToOptions } from '@/containers/BrandingTemplates/BrandingTemplatesSelectFields';
import {
  useCurrentOrganizationBaseCurrency,
  type PaymentReceiveNewPageEntry,
} from '@/hooks/query';
import {
  amountPaymentEntries as fillAmountPaymentEntries,
  defaultFastFieldShouldUpdate,
  transformToForm,
  safeSumBy,
  subtractAmounts,
  orderingLinesIndexes,
  formattedAmount,
} from '@/utils';

export type PaymentReceiveEntry = {
  index: string | number;
  paymentAmount: string | number;
  invoiceId: string | number;
  invoiceNo: string;
  dueAmount: string | number;
  date: string;
  amount: string | number;
  currencyCode: string;
  entryType?: string;
  branchId?: string | number;
  totalPaymentAmount?: string | number;
};

export type PaymentReceiveFormValues = {
  customerId: string | number;
  depositAccountId: string | number;
  paymentDate: string;
  referenceNo: string;
  paymentReceiveNo: string;
  paymentReceiveNoManually: string;
  statement: string;
  amount: string | number;
  currencyCode: string;
  exchangeRate: number;
  entries: PaymentReceiveEntry[];
  attachments: unknown[];
  branchId: string | number;
  pdfTemplateId: string | number;
};

export type PaymentReceiveRequestEntry = {
  index: string | number;
  paymentAmount: string | number;
  invoiceId?: string | number;
  entryType?: string;
};

// The entry type of the line that pays the customer opening balance.
export const OPENING_BALANCE_ENTRY_TYPE = 'opening_balance';

/**
 * Determines whether the given entry is the customer opening balance line.
 */
export const isOpeningBalanceEntry = (entry: { entryType?: string }) =>
  entry?.entryType === OPENING_BALANCE_ENTRY_TYPE;

export type PaymentReceiveRequestBody = {
  customerId: string | number;
  depositAccountId: string | number;
  paymentDate: string;
  paymentReceiveNo?: string;
  branchId: string | number;
  statement: string;
  entries: PaymentReceiveRequestEntry[];
  attachments: unknown[];
};

export type PaymentReceiveErrorResponse = {
  type: string;
  message?: string;
  indexes?: number[];
  meta?: unknown[];
};

type PaymentReceiveEditPage = NonNullable<
  ReturnType<typeof usePaymentReceiveFormContext>['paymentReceiveEditPage']
>;

// Default payment receive entry.
export const defaultPaymentReceiveEntry: PaymentReceiveEntry = {
  index: '',
  paymentAmount: '',
  entryType: 'invoice',
  invoiceId: '',
  invoiceNo: '',
  dueAmount: '',
  date: '',
  amount: '',
  currencyCode: '',
};

// Form initial values.
export const defaultPaymentReceive: PaymentReceiveFormValues = {
  customerId: '',
  depositAccountId: '',
  paymentDate: moment(new Date()).format('YYYY-MM-DD'),
  referenceNo: '',
  paymentReceiveNo: '',
  paymentReceiveNoManually: '',
  statement: '',
  amount: '',
  currencyCode: '',
  exchangeRate: 1,
  entries: [],
  attachments: [],
  branchId: '',
  pdfTemplateId: '',
};

export const defaultRequestPaymentEntry: PaymentReceiveRequestEntry = {
  index: '',
  paymentAmount: '',
  invoiceId: '',
  entryType: '',
};

export const defaultRequestPayment: PaymentReceiveRequestBody = {
  customerId: '',
  depositAccountId: '',
  paymentDate: '',
  paymentReceiveNo: '',
  branchId: '',
  statement: '',
  entries: [],
  attachments: [],
};

export type PaymentReceiveEditEntry = {
  paymentAmount?: string | number;
} & Partial<PaymentReceiveEntry>;

/**
 * Transformes the edit payment receive to initial values of the form.
 */
export const transformToEditForm = (
  paymentReceive: PaymentReceiveEditPage | Record<string, unknown>,
  paymentReceiveEntries: PaymentReceiveEditEntry[],
): PaymentReceiveFormValues =>
  ({
    ...transformToForm(paymentReceive, defaultPaymentReceive),
    entries: [
      ...paymentReceiveEntries.map((paymentReceiveEntry) => ({
        ...transformToForm(paymentReceiveEntry, defaultPaymentReceiveEntry),
        paymentAmount: paymentReceiveEntry.paymentAmount || '',
      })),
    ],
    attachments: transformAttachmentsToForm(paymentReceive),
  }) as PaymentReceiveFormValues;

/**
 * Transformes the new page open items (the opening balance first, then the
 * due invoices) to the form entries.
 */
export const transformNewPageEntriesToForm = (
  pageEntries: PaymentReceiveNewPageEntry[],
): PaymentReceiveEntry[] =>
  pageEntries.map((entry, index) => ({
    index: index + 1,
    entryType: entry.entryType || 'invoice',
    invoiceId: entry.invoiceId ?? '',
    invoiceNo: entry.invoiceNo ?? '',
    dueAmount: entry.dueAmount,
    date: entry.date,
    amount: entry.amount,
    currencyCode: entry.currencyCode,
    paymentAmount: '',
    totalPaymentAmount: entry.totalPaymentAmount,
  }));

export const clearAllPaymentEntries = (
  entries: PaymentReceiveEntry[],
): PaymentReceiveEntry[] => [
  ...entries.map((entry) => ({ ...entry, paymentAmount: 0 })),
];

export const amountPaymentEntries = (
  amount: number,
  entries: PaymentReceiveEntry[],
): PaymentReceiveEntry[] =>
  fillAmountPaymentEntries(amount, entries) as PaymentReceiveEntry[];

export const fullAmountPaymentEntries = (
  entries: PaymentReceiveEntry[],
): PaymentReceiveEntry[] => {
  return entries.map((item) => ({
    ...item,
    paymentAmount: item.dueAmount,
  }));
};

type FieldShouldUpdateDeps = {
  items?: unknown[];
  accounts?: unknown[];
  shouldUpdateDeps?: {
    items?: unknown[];
    accounts?: unknown[];
  };
};

/**
 * Detarmines the customers fast-field should update.
 */
export const customersFieldShouldUpdate = (
  newProps: FieldShouldUpdateDeps,
  oldProps: FieldShouldUpdateDeps,
): boolean => {
  return (
    newProps.shouldUpdateDeps?.items !== oldProps.shouldUpdateDeps?.items ||
    defaultFastFieldShouldUpdate(newProps, oldProps)
  );
};

type AccountsFieldShouldUpdateProps = {
  items?: unknown[];
  shouldUpdateDeps?: { items?: unknown[] };
};

/**
 * Detarmines the accounts fast-field should update.
 */
export const accountsFieldShouldUpdate = (
  newProps: AccountsFieldShouldUpdateProps,
  oldProps: AccountsFieldShouldUpdateProps,
): boolean => {
  return (
    newProps.items !== oldProps.items ||
    defaultFastFieldShouldUpdate(newProps, oldProps)
  );
};

/**
 * Tranformes form values to request.
 */
export const transformFormToRequest = (
  form: PaymentReceiveFormValues,
): PaymentReceiveRequestBody => {
  const entries = form.entries
    .filter(
      (entry) =>
        (entry.invoiceId || isOpeningBalanceEntry(entry)) &&
        entry.paymentAmount,
    )
    .map((entry) =>
      isOpeningBalanceEntry(entry)
        ? {
            ...pick(entry, ['index', 'paymentAmount']),
            entryType: OPENING_BALANCE_ENTRY_TYPE,
          }
        : {
            ...pick(entry, ['index', 'paymentAmount', 'invoiceId']),
            entryType: 'invoice',
          },
    ) as PaymentReceiveRequestEntry[];

  const attachments = transformAttachmentsToRequest(form);

  return {
    ...omit(form, ['paymentReceiveNoManually', 'paymentReceiveNo']),
    ...(form.paymentReceiveNoManually && {
      paymentReceiveNo: form.paymentReceiveNo,
    }),
    entries: orderingLinesIndexes(entries),
    attachments,
  } as PaymentReceiveRequestBody;
};

export const useSetPrimaryBranchToForm = () => {
  const { setFieldValue } = useFormikContext<PaymentReceiveFormValues>();
  const { branches, isBranchesSuccess, isNewMode } =
    usePaymentReceiveFormContext();

  React.useEffect(() => {
    if (isBranchesSuccess && isNewMode && branches) {
      const primaryBranch = branches.find((b) => b.primary) || first(branches);

      if (primaryBranch) {
        setFieldValue('branchId', primaryBranch.id);
      }
    }
  }, [isBranchesSuccess, setFieldValue, branches, isNewMode]);
};

/**
 * Transformes the response errors types.
 */
export const PAYMENT_ENTRIES_EXCEED_AMOUNT_MESSAGE =
  'The amounts applied to invoices are more than the amount received. Lower the invoice payment amounts or raise the amount received.';

export const DUPLICATE_INVOICE_ENTRIES_MESSAGE =
  'An invoice is listed twice in this payment. Combine the amounts into one line.';

export const NO_INVOICE_SELECTED_MESSAGE =
  'Select at least one invoice to apply this payment to.';

export const PAYMENT_RECEIVE_ERROR_MESSAGES: Record<string, string> = {
  INVOICES_IDS_NOT_FOUND: NO_INVOICE_SELECTED_MESSAGE,
  INVOICES_NOT_DELIVERED_YET:
    'One of the selected invoices is still a draft. Deliver the invoice before receiving a payment for it.',
  OPENING_BALANCE_NOT_FOUND: 'This customer has no opening balance to pay.',
  OPENING_BALANCE_PAYMENT_EXCEEDS_DUE:
    'The amount for the opening balance is more than what is still due on it. Lower it to the opening balance due.',
  OPENING_BALANCE_ENTRY_DUPLICATE:
    'The opening balance can only appear once in a payment.',
  INVALID_PAYMENT_AMOUNT:
    'The amount for an invoice is more than what is still due on it.',
};

export const transformErrors = (
  errors: PaymentReceiveErrorResponse[],
  {
    setFieldError,
  }: { setFieldError: (field: string, message: string) => void },
): void => {
  const getError = (errorType: string) =>
    errors.find((e) => e.type === errorType);

  if (getError('PAYMENT_RECEIVE_NO_EXISTS')) {
    setFieldError('paymentReceiveNo', intl.get('payment_number_is_not_unique'));
  }
  if (getError('PAYMENT_RECEIVE_NO_REQUIRED')) {
    setFieldError(
      'paymentReceiveNo',
      intl.get('payment_received.field.error.payment_receive_no_required'),
    );
  }
  if (getError('PAYMENT_ENTRIES_EXCEED_AMOUNT')) {
    AppToaster.show({
      message: PAYMENT_ENTRIES_EXCEED_AMOUNT_MESSAGE,
      intent: Intent.DANGER,
    });
  }
  Object.entries(PAYMENT_RECEIVE_ERROR_MESSAGES).forEach(([type, message]) => {
    if (getError(type)) {
      AppToaster.show({ message, intent: Intent.DANGER });
    }
  });
  // The server names the invoice ("INV-12 is listed twice ...").
  const duplicate = getError('PAYMENT_DUPLICATE_INVOICE_ENTRIES');
  if (duplicate) {
    AppToaster.show({
      message: duplicate.message || DUPLICATE_INVOICE_ENTRIES_MESSAGE,
      intent: Intent.DANGER,
    });
  }
  if (getError('PAYMENT_ACCOUNT_CURRENCY_INVALID')) {
    AppToaster.show({
      message: intl.get(
        'payment_Receive.error.payment_account_currency_invalid',
      ),
      intent: Intent.DANGER,
    });
  }
};

/**
 * Retreives the payment receive totals.
 */
export const usePaymentReceiveTotals = () => {
  const {
    values: { entries, currencyCode },
  } = useFormikContext<PaymentReceiveFormValues>();

  const total = React.useMemo(
    () => safeSumBy(entries, 'paymentAmount'),
    [entries],
  );

  const formattedTotal = React.useMemo(
    () => formattedAmount(total, currencyCode),
    [total, currencyCode],
  );
  const formattedSubtotal = React.useMemo(
    () => formattedAmount(total, currencyCode, { money: false }),
    [total, currencyCode],
  );

  return {
    total,
    formattedTotal,
    formattedSubtotal,
  };
};

export const usePaymentReceivedTotalAppliedAmount = (): number => {
  const {
    values: { entries },
  } = useFormikContext<PaymentReceiveFormValues>();

  return React.useMemo(() => safeSumBy(entries, 'paymentAmount'), [entries]);
};

export const usePaymentReceivedTotalAmount = () => {
  const {
    values: { amount },
  } = useFormikContext<PaymentReceiveFormValues>();

  return amount;
};

// Received more than applied to invoices (the rest is an excess payment).
export const usePaymentReceivedTotalExceededAmount = (): number => {
  const totalAmount = usePaymentReceivedTotalAmount();
  const totalApplied = usePaymentReceivedTotalAppliedAmount();

  return Math.max(subtractAmounts(Number(totalAmount), totalApplied), 0);
};

// Applied to invoices more than was received, which can't be saved.
export const usePaymentReceivedOverAppliedAmount = (): number => {
  const totalAmount = usePaymentReceivedTotalAmount();
  const totalApplied = usePaymentReceivedTotalAppliedAmount();

  return Math.max(subtractAmounts(totalApplied, Number(totalAmount)), 0);
};

/**
 * Detarmines whether the payment has foreign customer.
 */
export const useEstimateIsForeignCustomer = (): boolean => {
  const { values } = useFormikContext<PaymentReceiveFormValues>();
  const baseCurrency = useCurrentOrganizationBaseCurrency();

  const isForeignCustomer = React.useMemo(
    () => values.currencyCode !== baseCurrency,
    [values.currencyCode, baseCurrency],
  );
  return isForeignCustomer;
};

type ResetFormStateArgs = {
  initialValues: PaymentReceiveFormValues;
  values: PaymentReceiveFormValues;
  resetForm: (nextState?: { values: PaymentReceiveFormValues }) => void;
};

export const resetFormState = ({
  initialValues,
  values,
  resetForm,
}: ResetFormStateArgs) => {
  resetForm({
    values: {
      ...initialValues,
      branchId: values.branchId,
    },
  });
};

export const getExceededAmountFromValues = (
  values: PaymentReceiveFormValues,
): number => {
  const totalApplied = safeSumBy(values.entries, 'paymentAmount');
  const totalAmount = Number(values.amount);

  return subtractAmounts(totalAmount, totalApplied);
};

export const usePaymentReceivedFormBrandingTemplatesOptions = () => {
  const { brandingTemplates } = usePaymentReceiveFormContext();

  return React.useMemo(
    () =>
      convertBrandingTemplatesToOptions(
        (brandingTemplates ?? []) as Parameters<
          typeof convertBrandingTemplatesToOptions
        >[0],
      ),
    [brandingTemplates],
  );
};
