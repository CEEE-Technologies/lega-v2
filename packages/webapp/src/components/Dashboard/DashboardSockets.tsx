import { Intent } from '@blueprintjs/core';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { io } from 'socket.io-client';
import { AppToaster, FormattedMessage as T } from '@/components';
import { workspacesKeys } from '@/ee/workspaces/hooks/query';
import { AccountsQueryKeys } from '@/hooks/query/accounts';
import { CashflowAccountsQueryKeys } from '@/hooks/query/cashflow-accounts';
import { useAuthOrganizationId, useAuthToken } from '@/hooks/state';

export function DashboardSockets() {
  const socket = useRef<any>();
  const client = useQueryClient();
  const token = useAuthToken();
  const organizationId = useAuthOrganizationId();

  useEffect(() => {
    // The server only accepts signed-in connections, and only sends each
    // organization's updates to its members.
    if (!token) return undefined;

    socket.current = io('/', {
      path: '/socket',
      auth: { token, organizationId },
    });

    socket.current.on('NEW_TRANSACTIONS_DATA', () => {
      client.invalidateQueries({ queryKey: [AccountsQueryKeys.ACCOUNTS] });
      client.invalidateQueries({
        queryKey: [AccountsQueryKeys.ACCOUNT_TRANSACTION],
      });
      client.invalidateQueries({
        queryKey: [CashflowAccountsQueryKeys.CASH_FLOW_ACCOUNTS],
      });
      client.invalidateQueries({
        queryKey: [CashflowAccountsQueryKeys.CASH_FLOW_TRANSACTIONS],
      });

      AppToaster.show({
        message: 'The Plaid connected accounts have been updated.',
        intent: Intent.SUCCESS,
      });
    });
    socket.current.on('SUBSCRIPTION_CHANGED', () => {
      client.invalidateQueries({ queryKey: ['GetSubscriptions'] });
    });
    socket.current.on('WORKSPACES_CHANGED', () => {
      client.invalidateQueries({ queryKey: workspacesKeys.all() });
      AppToaster.show({
        message: <T id={'workspaces.workspace_ready_to_switch'} />,
        intent: Intent.SUCCESS,
      });
    });
    return () => {
      socket.current.removeAllListeners();
      socket.current.close();
    };
  }, [client, token, organizationId]);
  return null;
}
