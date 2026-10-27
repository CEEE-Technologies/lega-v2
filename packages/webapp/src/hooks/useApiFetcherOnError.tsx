import { Intent } from '@blueprintjs/core';
import { useCallback } from 'react';
import { useAuthActions, useSetGlobalErrors } from './state';
import type { ApiError } from 'openapi-typescript-fetch';
import { AppToaster } from '@/components/AppToaster';

/**
 * Returns a stable callback that translates SDK fetcher rejections into
 * global-error Redux state. Mirrors the response interceptor that used to
 * live on the legacy axios instance (see useRequest.tsx), but adapted to
 * openapi-typescript-fetch's ApiError shape (`error.data` instead of
 * `error.response.data`).
 */
export function useApiFetcherOnError() {
  const setGlobalErrors = useSetGlobalErrors();
  const { setLogout } = useAuthActions();

  return useCallback(
    (error: unknown) => {
      const { status, data } = (error as ApiError) ?? {};
      if (typeof status !== 'number') return;

      if (status >= 500) {
        setGlobalErrors({ something_wrong: true });
      }
      if (status === 401) {
        setGlobalErrors({ session_expired: true });
        setLogout();
      }
      if (status === 403) {
        setGlobalErrors({ access_denied: { message: data?.message } });
      }
      if (status === 429) {
        setGlobalErrors({ too_many_requests: true });
      }
      if (status === 400 && Array.isArray(data?.errors)) {
        const lockedError = data.errors.find(
          (e: { type?: string }) => e.type === 'TRANSACTIONS_DATE_LOCKED',
        );
        if (lockedError) {
          setGlobalErrors({
            transactionsLocked: { ...lockedError.payload },
          });
        }
        // A payment or refund linked to the edited document is in a locked
        // period; the server message names it.
        const linkedLockedError = data.errors.find(
          (e: { type?: string }) =>
            e.type === 'LINKED_TRANSACTIONS_DATE_LOCKED',
        );
        if (linkedLockedError) {
          AppToaster.show({
            message:
              linkedLockedError.message ||
              'A linked payment or refund is in a locked period.',
            intent: Intent.DANGER,
            timeout: 10000,
          });
        }
        if (
          data.errors.find(
            (e: { type?: string }) =>
              e.type === 'ORGANIZATION.SUBSCRIPTION.INACTIVE',
          )
        ) {
          setGlobalErrors({ subscriptionInactive: true });
        }
        if (
          data.errors.find((e: { type?: string }) => e.type === 'USER_INACTIVE')
        ) {
          setGlobalErrors({ userInactive: true });
          setLogout();
        }
      }
    },
    [setGlobalErrors, setLogout],
  );
}
