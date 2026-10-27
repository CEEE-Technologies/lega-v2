import { isEmpty } from 'lodash';
import React from 'react';
import intl from 'react-intl-universal';
import { useAccountDrawerContext } from './AccountDrawerProvider';
import { Icon, DetailsMenu, DetailItem } from '@/components';

/**
 *  Account drawer header.
 */
export function AccountDrawerHeader() {
  const { account } = useAccountDrawerContext();

  if (!account) {
    return null;
  }

  return (
    <div className={'account-drawer__content-header'}>
      <DetailsMenu>
        <DetailItem
          name={'closing-balance'}
          label={intl.get('closing_balance')}
        >
          <h3 className={'big-number'}>{account?.formattedAmount}</h3>
        </DetailItem>

        <DetailItem name={'account-type'} label={intl.get('account_type')}>
          {account?.accountTypeLabel}
        </DetailItem>

        <DetailItem name={'account-normal'} label={intl.get('account_normal')}>
          {account?.accountNormalFormatted}
          <Icon
            iconSize={14}
            icon={`arrow-${
              account?.accountNormal === 'credit' ? 'down' : 'up'
            }`}
          />
        </DetailItem>

        <DetailItem name={'code'} label={intl.get('code')}>
          {account?.code}
        </DetailItem>

        <DetailItem name={'currency'} label={intl.get('currency')}>
          {account?.currencyCode}
        </DetailItem>

        <DetailItem name={'basis'} label={'Basis'}>
          <span
            title={
              'The closing balance and the transactions below are on the accrual basis. Cash basis entries show in the General Ledger on the cash basis.'
            }
          >
            Accrual basis
          </span>
        </DetailItem>
      </DetailsMenu>

      <DetailsMenu direction={'horizantal'}>
        <DetailItem name={'description'} label={intl.get('description')}>
          {!isEmpty(account?.description) ? account?.description : '--'}
        </DetailItem>
      </DetailsMenu>
    </div>
  );
}
