import * as FF from 'fp-ts/function';
import moment from 'moment';
import React from 'react';
import intl from 'react-intl-universal';
import { Link } from 'react-router-dom';
import styled from 'styled-components';
import { useAccountDrawerContext } from './AccountDrawerProvider';
import { AccountDrawerTableHeader } from './AccountDrawerTableHeader';
import { AccountDrawerTableOptionsProvider } from './AccountDrawerTableOptionsProvider';
import { useAccountReadEntriesColumns } from './utils';
import { Card, DataTable, If } from '@/components';
import { useAppIntlContext } from '@/components/AppIntlProvider';
import { TableStyle } from '@/constants';
import {
  withDrawerActions,
  WithDrawerActionsProps,
} from '@/containers/Drawer/withDrawerActions';

/**
 * account drawer table.
 */
// Accounts posted only on the cash basis: the payment excess (customer
// advances / vendor prepayments) has no accrual entries.
const CASH_BASIS_ONLY_ACCOUNTS = ['unearned-revenue', 'prepaid-expenses'];

/**
 * Retrieves the general ledger link of the given account: on the cash basis
 * for the cash basis only accounts.
 */
const getGeneralLedgerLink = (account?: { id?: number; slug?: string }) => {
  if (!account?.id || !CASH_BASIS_ONLY_ACCOUNTS.includes(account.slug ?? '')) {
    return '/financial-reports/general-ledger';
  }
  const params = new URLSearchParams({
    basis: 'cash',
    accountsIds: String(account.id),
    fromDate: moment()
      .subtract(10, 'years')
      .startOf('year')
      .format('YYYY-MM-DD'),
    toDate: moment().format('YYYY-MM-DD'),
  });
  return `/financial-reports/general-ledger?${params.toString()}`;
};

function AccountDrawerTableInner({ closeDrawer }: WithDrawerActionsProps) {
  const { account, accounts, drawerName } = useAccountDrawerContext();
  const isCashBasisOnly = CASH_BASIS_ONLY_ACCOUNTS.includes(
    (account as { slug?: string } | undefined)?.slug ?? '',
  );

  // Handle view more link click.
  const handleLinkClick = () => {
    closeDrawer(drawerName);
  };
  // Application intl context.
  const { isRTL } = useAppIntlContext();

  return (
    <Card>
      <AccountDrawerTableOptionsProvider>
        <AccountDrawerTableHeader />
        <AccountDrawerDataTable />

        <If condition={(accounts?.length ?? 0) > 0 || isCashBasisOnly}>
          <TableFooter>
            {isCashBasisOnly && (
              <div style={{ marginBottom: 4, opacity: 0.8 }}>
                This account is used on the cash basis only (unapplied
                payments), so it has no accrual transactions.
              </div>
            )}
            <Link
              to={getGeneralLedgerLink(
                account as { id?: number; slug?: string } | undefined,
              )}
              onClick={handleLinkClick}
            >
              {isRTL ? '→' : '←'}{' '}
              {isCashBasisOnly
                ? 'View in General Ledger (cash basis)'
                : intl.get('view_more_transactions')}
            </Link>
          </TableFooter>
        </If>
      </AccountDrawerTableOptionsProvider>
    </Card>
  );
}

function AccountDrawerDataTable() {
  const { account, accounts } = useAccountDrawerContext();

  // Account read-only entries table columns.
  const columns = useAccountReadEntriesColumns();

  return (
    <DataTable
      columns={columns}
      data={accounts ?? []}
      payload={{ account }}
      styleName={TableStyle.Constrant}
    />
  );
}

export const AccountDrawerTable = FF.pipe(
  AccountDrawerTableInner,
  withDrawerActions,
);

const TableFooter = styled.div`
  --x-border-color: #d2dde2;

  .bp4-dark & {
    --x-border-color: var(--color-dark-gray5);
  }
  padding: 6px 14px;
  display: block;
  border-top: 1px solid var(--x-border-color);
  border-bottom: 1px solid var(--x-border-color);
  font-size: 12px;
`;
