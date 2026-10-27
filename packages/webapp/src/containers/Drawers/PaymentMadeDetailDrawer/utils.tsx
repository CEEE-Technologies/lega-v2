import React from 'react';
import intl from 'react-intl-universal';
import { usePaymentMadeDetailContext } from './PaymentMadeDetailProvider';
import { FormatNumberCell } from '@/components';
import { getColumnWidth } from '@/utils';

/**
 * Number cell that stays blank without a value (the opening balance line
 * has no bill amounts).
 */
function OptionalFormatNumberCell(
  props: React.ComponentProps<typeof FormatNumberCell>,
) {
  const { value } = props as { value?: unknown };

  if (value === null || value === undefined || value === '') {
    return null;
  }
  return <FormatNumberCell {...props} />;
}

/**
 * Retrieve payment made entries table columns.
 */
export const usePaymentMadeEntriesColumns = () => {
  const { paymentMade } = usePaymentMadeDetailContext();
  const entries = paymentMade?.entries ?? [];

  return React.useMemo(
    () => [
      {
        Header: intl.get('date'),
        accessor: 'bill.formattedBillDate',
        width: 100,
        disableSortBy: true,
        className: 'date',
      },
      {
        Header: intl.get('bill_number'),
        id: 'billNo',
        // The vendor opening balance line has no bill.
        accessor: (row: { entryType?: string; bill?: { billNo?: string } }) =>
          row.entryType === 'opening_balance'
            ? 'Opening balance'
            : row.bill?.billNo,
        width: 150,
        disableSortBy: true,
        className: 'bill_number',
      },
      {
        Header: intl.get('bill_amount'),
        accessor: 'bill.totalFormatted',
        Cell: OptionalFormatNumberCell,
        width: getColumnWidth(entries, 'bill.totalFormatted', {
          minWidth: 60,
          magicSpacing: 5,
        }),
        align: 'right',
      },
      {
        Header: intl.get('due_amount'),
        accessor: 'bill.dueAmountFormatted',
        Cell: OptionalFormatNumberCell,
        width: getColumnWidth(entries, 'bill.dueAmountFormatted', {
          minWidth: 60,
          magicSpacing: 5,
        }),
        disableSortBy: true,
        align: 'right',
      },
      {
        Header: intl.get('payment_amount'),
        accessor: 'paymentAmountFormatted',
        width: getColumnWidth(entries, 'paymentAmountFormatted', {
          minWidth: 60,
          magicSpacing: 5,
        }),
        disableSortBy: true,
        textOverview: true,
        align: 'right',
      },
    ],
    [entries],
  );
};
