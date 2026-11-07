import { Intent } from '@blueprintjs/core';
import React from 'react';
import { useEffect } from 'react';
import { useHistory, useLocation } from 'react-router-dom';
import { AppToaster } from '@/components';
import { useSetStripeAccountCallback } from '@/hooks/query/stripe-integration';

function useQuery() {
  const { search } = useLocation();

  return React.useMemo(() => new URLSearchParams(search), [search]);
}

const STATE_REFUSED_MESSAGE =
  "This Stripe connection wasn't started from your account.";

interface CallbackError {
  response?: { data?: { errors?: Array<{ type?: string; message?: string }> } };
  data?: { errors?: Array<{ type?: string; message?: string }> };
}

/**
 * Stripe sends the user back here after they connect their account. The
 * `state` proves the connection was started by this user in this
 * organization; the server refuses the code without it.
 */
export function PreferencesStripeCallback() {
  const query = useQuery();
  const code = query.get('code') as string;
  const state = query.get('state') ?? undefined;
  const { mutateAsync: stripeAccountCallback } = useSetStripeAccountCallback();

  const history = useHistory();

  useEffect(() => {
    stripeAccountCallback({ code, state })
      .catch((error: CallbackError) => {
        const errors = error?.data?.errors ?? error?.response?.data?.errors;
        const refused = errors?.find(
          (e) => e.type === 'STRIPE_CONNECT_STATE_INVALID',
        );
        AppToaster.show({
          message:
            refused?.message ??
            (refused
              ? STATE_REFUSED_MESSAGE
              : 'Stripe could not be connected.'),
          intent: Intent.DANGER,
        });
      })
      .finally(() => {
        history.push('/preferences/payment-methods');
      });
  }, [history, stripeAccountCallback, code, state]);

  return null;
}
