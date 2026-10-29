import { Intent } from '@blueprintjs/core';
import { useFormikContext } from 'formik';
import { pick, first } from 'lodash';
import moment from 'moment';
import React from 'react';
import intl from 'react-intl-universal';
import { PAYMENT_MADE_ERRORS } from '../constants';
import { usePaymentMadeFormContext } from './PaymentMadeFormProvider';
import { AppToaster } from '@/components';
import {
  transformAttachmentsToForm,
  transformAttachmentsToRequest,
} from '@/containers/Attachments/utils';
import { useCurrentOrganizationBaseCurrency } from '@/hooks/query';
import {
  amountPaymentEntries as fillAmountPaymentEntries,
  defaultFastFieldShouldUpdate,
  safeSumBy,
  subtractAmounts,
  transformToForm,
  orderingLinesIndexes,
  formattedAmount,
} from '@/utils';

export type PaymentMadeEntry = {
  index?: string | number;
  billId: string | number;
  paymentAmount: string | number;
  currencyCode: string;
  id: number | null;
  dueAmount: string | number | null;
  amount: string | number;
  billNo?: string;
  date?: string;
  entryType?: string;
  branchId?: string | number;
  totalPaymentAmount?: string | number;
};

export type PaymentMadeFormValues = {
  amount: string | number;
  vendorId: string | number;
  paymentAccountId: string | number;
  paymentDate: string;
  reference: string;
  paymentNumber: string;
  statement: string;
  currencyCode: string;
  branchId: string | number;
  exchangeRate: number;
  entries: PaymentMadeEntry[];
  attachments: unknown[];
};

export type PaymentMadeRequestEntry = {
  index?: string | number;
  paymentAmount: string | number;
  billId?: string | number;
  entryType?: string;
};

// The entry type of the line that pays the vendor opening balance.
export const OPENING_BALANCE_ENTRY_TYPE = 'opening_balance';

/**
 * Determines whether the given entry is the vendor opening balance line.
 */
export const isOpeningBalanceEntry = (entry: { entryType?: string }) =>
  entry?.entryType === OPENING_BALANCE_ENTRY_TYPE;

export type PaymentMadeRequestBody = {
  vendorId: string | number;
  amount: string | number;
  paymentAccountId: string | number;
  paymentNumber: string;
  paymentDate: string;
  exchangeRate: number;
  statement: string;
  branchId: string | number;
  entries: PaymentMadeRequestEntry[];
  attachments: unknown[];
};

export type PaymentMadeErrorResponse = {
  type: string;
  message?: string;
  indexes?: number[];
  meta?: unknown[];
};

type PaymentMadeEditPage = NonNullable<
  ReturnType<typeof usePaymentMadeFormContext>['paymentMadeEditPage']
>;

export type PaymentMadeEditEntry = {
  paymentAmount?: string | number;
} & Partial<PaymentMadeEntry>;

/**
 * Source shape returned by `usePaymentMadeNewPageEntries`.
 * Query enables `enableCamelCaseTransform`, so fields are camelCase.
 */
type BillRow = {
  id?: string | number;
  entryType?: string;
  billId?: string | number;
  dueAmount?: string | number;
  date?: string;
  amount?: string | number;
  currencyCode?: string;
  billNo?: string;
  branchId?: string | number;
  totalPaymentAmount?: string | number;
};

export const ERRORS = {
  PAYMENT_NUMBER_NOT_UNIQUE: 'PAYMENT.NUMBER.NOT.UNIQUE',
} as const;

// Default payment made entry values.
export const defaultPaymentMadeEntry: PaymentMadeEntry = {
  entryType: 'invoice',
  billId: '',
  billNo: '',
  date: '',
  paymentAmount: '',
  currencyCode: '',
  id: null,
  dueAmount: null,
  amount: '',
  totalPaymentAmount: '',
};

// Default initial values of payment made.
export const defaultPaymentMade: PaymentMadeFormValues = {
  amount: '',
  vendorId: '',
  paymentAccountId: '',
  paymentDate: moment(new Date()).format('YYYY-MM-DD'),
  reference: '',
  paymentNumber: '',
  statement: '',
  currencyCode: '',
  branchId: '',
  exchangeRate: 1,
  entries: [],
  attachments: [],
};

/**
 * Transformes the edit payment made to initial values of the form.
 */
export const transformToEditForm = (
  paymentMade: PaymentMadeEditPage | Record<string, unknown>,
  paymentMadeEntries: PaymentMadeEditEntry[],
): PaymentMadeFormValues =>
  ({
    ...transformToForm(paymentMade, defaultPaymentMade),
    entries: [
      ...paymentMadeEntries.map((paymentMadeEntry) => ({
        ...transformToForm(paymentMadeEntry, defaultPaymentMadeEntry),
        paymentAmount: paymentMadeEntry.paymentAmount || '',
      })),
    ],
    attachments: transformAttachmentsToForm(paymentMade),
  }) as PaymentMadeFormValues;

/**
 * Transform the new page entries.
 */
export const transformToNewPageEntries = (
  entries: BillRow[],
): PaymentMadeEntry[] =>
  entries.map((entry) => ({
    ...transformToForm(entry, defaultPaymentMadeEntry),
    paymentAmount: '',
    currencyCode: entry.currencyCode,
  })) as PaymentMadeEntry[];

type FieldShouldUpdateDeps = {
  items?: unknown[];
  accounts?: unknown[];
  shouldUpdateDeps?: {
    items?: unknown[];
    accounts?: unknown[];
  };
};

/**
 * Detarmines vendors fast field when update.
 */
export const vendorsFieldShouldUpdate = (
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
 * Detarmines accounts fast field when update.
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
 * Transformes the form values to request body.
 */
export const transformFormToRequest = (
  form: PaymentMadeFormValues,
): PaymentMadeRequestBody => {
  // Filters entries that have no `billId` (bar the opening balance line) or
  // no `paymentAmount`.
  const entries = form.entries
    .filter(
      (item) =>
        (item.billId || isOpeningBalanceEntry(item)) && item.paymentAmount,
    )
    .map((entry) =>
      isOpeningBalanceEntry(entry)
        ? {
            ...pick(entry, ['paymentAmount']),
            entryType: OPENING_BALANCE_ENTRY_TYPE,
          }
        : { ...pick(entry, ['paymentAmount', 'billId']), entryType: 'invoice' },
    ) as PaymentMadeRequestEntry[];

  const attachments = transformAttachmentsToRequest(form);

  return {
    ...form,
    entries: orderingLinesIndexes(entries),
    attachments,
  } as PaymentMadeRequestBody;
};

export const useSetPrimaryBranchToForm = () => {
  const { setFieldValue } = useFormikContext<PaymentMadeFormValues>();
  const { branches, isBranchesSuccess, isNewMode } =
    usePaymentMadeFormContext();

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
export const PAYMENT_MADE_ENTRIES_EXCEED_AMOUNT_MESSAGE =
  'The amounts applied to bills are more than the amount paid. Lower the bill payment amounts or raise the amount paid.';

/**
 * The over-applied message shown before saving, with both amounts.
 */
export const getPaymentMadeOverAppliedMessage = (
  appliedAmount: string,
  paymentAmount: string,
) =>
  `The amount applied to bills (${appliedAmount}) is more than the payment amount (${paymentAmount}). Lower the bill payment amounts or raise the payment amount.`;

export const DUPLICATE_BILL_ENTRIES_MESSAGE =
  'A bill is listed twice in this payment. Combine the amounts into one line.';

export const PAYMENT_MADE_ERROR_MESSAGES: Record<string, string> = {
  BILL_ENTRIES_IDS_NOT_FOUND:
    'One of the selected bills was not found for this vendor.',
  BILLS_NOT_OPENED_YET:
    'One of the selected bills is still a draft. Open the bill before paying it.',
  INVALID_BILL_PAYMENT_AMOUNT:
    'The amount for a bill is more than what is still due on it.',
  OPENING_BALANCE_NOT_FOUND: 'This vendor has no opening balance to pay.',
  OPENING_BALANCE_PAYMENT_EXCEEDS_DUE:
    'The amount for the opening balance is more than what is still due on it. Lower it to the opening balance due.',
  OPENING_BALANCE_ENTRY_DUPLICATE:
    'The opening balance can only appear once in a payment.',
};

export const transformErrors = (
  errors: PaymentMadeErrorResponse[],
  {
    setFieldError,
  }: { setFieldError: (field: string, message: string) => void },
): void => {
  const getError = (errorType: string) =>
    errors.find((e) => e.type === errorType);

  if (getError(PAYMENT_MADE_ERRORS.PAYMENT_NUMBER_NOT_UNIQUE)) {
    setFieldError('paymentNumber', intl.get('payment_number_is_not_unique'));
  }
  if (getError(PAYMENT_MADE_ERRORS.WITHDRAWAL_ACCOUNT_CURRENCY_INVALID)) {
    AppToaster.show({
      message: intl.get(
        'payment_made.error.withdrawal_account_currency_invalid',
      ),
      intent: Intent.DANGER,
    });
  }
  if (getError(PAYMENT_MADE_ERRORS.PAYMENT_ENTRIES_EXCEED_AMOUNT)) {
    AppToaster.show({
      message: PAYMENT_MADE_ENTRIES_EXCEED_AMOUNT_MESSAGE,
      intent: Intent.DANGER,
    });
  }
  Object.entries(PAYMENT_MADE_ERROR_MESSAGES).forEach(([type, message]) => {
    if (getError(type)) {
      AppToaster.show({ message, intent: Intent.DANGER });
    }
  });
  // The server names the bill ("BILL-12 is listed twice ...").
  const duplicate = getError('PAYMENT_DUPLICATE_BILL_ENTRIES');
  if (duplicate) {
    AppToaster.show({
      message: duplicate.message || DUPLICATE_BILL_ENTRIES_MESSAGE,
      intent: Intent.DANGER,
    });
  }
};

/**
 * Retreives the payment made totals.
 */
export const usePaymentMadeTotals = () => {
  const {
    values: { entries, currencyCode },
  } = useFormikContext<PaymentMadeFormValues>();

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

export const usePaymentmadeTotalAmount = () => {
  const {
    values: { amount },
  } = useFormikContext<PaymentMadeFormValues>();

  return amount;
};

export const usePaymentMadeAppliedAmount = (): number => {
  const {
    values: { entries },
  } = useFormikContext<PaymentMadeFormValues>();

  return React.useMemo(() => safeSumBy(entries, 'paymentAmount'), [entries]);
};

// Paid more than applied to bills (the rest is an excess payment). An
// over-applied payment has no excess.
export const usePaymentMadeExcessAmount = (): number => {
  const appliedAmount = usePaymentMadeAppliedAmount();
  const totalAmount = usePaymentmadeTotalAmount();

  return Math.max(subtractAmounts(Number(totalAmount), appliedAmount), 0);
};

/**
 * Detarmines whether the bill has foreign customer.
 */
export const usePaymentMadeIsForeignCustomer = (): boolean => {
  const { values } = useFormikContext<PaymentMadeFormValues>();
  const baseCurrency = useCurrentOrganizationBaseCurrency();

  const isForeignCustomer = React.useMemo(
    () => values.currencyCode !== baseCurrency,
    [values.currencyCode, baseCurrency],
  );
  return isForeignCustomer;
};

/**
 * Retrieves the payment amount less the amount applied to bills: positive
 * for an excess payment, negative for an over-applied one.
 */
export const getPaymentExcessAmountFromValues = (
  values: PaymentMadeFormValues,
): number => {
  const appliedAmount = safeSumBy(values.entries, 'paymentAmount');
  const totalAmount = Number(values.amount);

  return subtractAmounts(totalAmount, appliedAmount);
};

export const amountPaymentEntries = (
  amount: number,
  entries: PaymentMadeEntry[],
): PaymentMadeEntry[] =>
  fillAmountPaymentEntries(amount, entries) as PaymentMadeEntry[];

export const fullAmountPaymentEntries = (
  entries: PaymentMadeEntry[],
): PaymentMadeEntry[] =>
  entries.map((item) => ({
    ...item,
    paymentAmount: item.dueAmount ?? 0,
  }));
