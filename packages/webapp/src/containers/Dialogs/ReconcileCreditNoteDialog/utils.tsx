import { Callout, Intent, Classes } from '@blueprintjs/core';
import clsx from 'classnames';
import React from 'react';
import intl from 'react-intl-universal';
import { fromCents, toCents } from '@bigcapital/utils';
import type { ReconcileCreditNoteFormEntry } from './types';
import { AppToaster, FormatDateCell, MoneyFieldCell, T } from '@/components';
import { CLASSES } from '@/constants/classes';

interface ResponseError {
  type: string;
}

interface TransformErrorsArgs {
  setErrors: (errors: Partial<Record<string, string>>) => void;
}

export const transformErrors = (
  errors: ResponseError[],
  { setErrors }: TransformErrorsArgs,
) => {
  if (errors.some((e) => e.type === 'INVOICES_HAS_NO_REMAINING_AMOUNT')) {
    AppToaster.show({
      message:
        'The amount credit from the given invoice has no remaining amount.',
      intent: Intent.DANGER,
    });
  }
  if (
    errors.find((error) => error.type === 'CREDIT_NOTE_HAS_NO_REMAINING_AMOUNT')
  ) {
    AppToaster.show({
      message: 'The total amount bigger than from remaining credit note amount',
      intent: Intent.DANGER,
    });
  }
  void setErrors;
};

/**
 * Empty status callout.
 */
export function EmptyStatuCallout(): React.ReactElement {
  return (
    <div className={Classes.DIALOG_BODY}>
      <Callout intent={Intent.PRIMARY}>
        <p>
          <T
            id={'reconcile_credit_note.alert.there_is_no_open_sale_invoices'}
          />
        </p>
      </Callout>
    </div>
  );
}

/**
 * Retrieves reconcile credit note table columns.
 */
export const useReconcileCreditNoteTableColumns = () => {
  return React.useMemo(
    () => [
      {
        Header: intl.get('invoice_date'),
        accessor: 'formattedInvoiceDate',
        Cell: FormatDateCell,
        disableSortBy: true,
        width: '120',
      },
      {
        Header: intl.get('invoice_no'),
        accessor: 'invoiceNo',
        disableSortBy: true,
        width: '100',
      },
      {
        Header: intl.get('amount'),
        accessor: 'formattedAmount',
        disableSortBy: true,
        align: 'right',
        width: '100',
      },
      {
        Header: intl.get('reconcile_credit_note.column.remaining_amount'),
        accessor: 'formattedDueAmount',
        disableSortBy: true,
        align: 'right',
        width: '150',
        className: clsx(CLASSES.FONT_BOLD),
      },
      {
        Header: intl.get('reconcile_credit_note.column.amount_to_credit'),
        accessor: 'amount',
        Cell: MoneyFieldCell,
        disableSortBy: true,
        width: '150',
      },
    ],
    [],
  );
};

/**
 * Caps each credit amount at the invoice's due amount (what is still owed,
 * tax and adjustment included), in whole cents.
 */
export const maxAmountCreditFromRemaining = (
  entries: ReconcileCreditNoteFormEntry[],
): ReconcileCreditNoteFormEntry[] => {
  return entries.map((entry) => {
    const due = (entry.dueAmount ?? entry.balance ?? 0) as number;
    return {
      ...entry,
      amount: entry.amount
        ? fromCents(Math.min(toCents(due), toCents(entry.amount as number)))
        : '',
    };
  });
};

/**
 * Adjusts entries amount based on the given total.
 */
export const maxCreditNoteAmountEntries =
  (total: number) =>
  (entries: ReconcileCreditNoteFormEntry[]): ReconcileCreditNoteFormEntry[] => {
    // Running balance in whole cents.
    let balanceCents = toCents(total);

    return entries.map((entry) => {
      const oldBalanceCents = balanceCents;
      balanceCents -= entry.amount ? toCents(entry.amount as number) : 0;

      return {
        ...entry,
        amount: entry.amount
          ? fromCents(
              Math.max(
                Math.min(toCents(entry.amount as number), oldBalanceCents),
                0,
              ),
            )
          : '',
      };
    });
  };
