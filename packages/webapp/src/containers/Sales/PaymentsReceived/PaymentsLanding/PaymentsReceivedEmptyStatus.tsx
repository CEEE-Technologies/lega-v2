import { Button, Intent } from '@blueprintjs/core';
import React from 'react';
import { useHistory } from 'react-router-dom';
import { EmptyStatus } from '@/components';
import { Can, FormattedMessage as T } from '@/components';
import {
  PaymentReceiveAction,
  AbilitySubject,
} from '@/constants/abilityOption';
import { brandLinks } from '@/constants/branding';

export function PaymentsReceivedEmptyStatus() {
  const history = useHistory();

  return (
    <EmptyStatus
      title={<T id={'the_organization_doesn_t_receive_money_yet'} />}
      description={
        <p>
          <T
            id={'receiving_customer_payments_is_one_pleasant_accounting_tasks'}
          />
        </p>
      }
      action={
        <>
          <Can
            I={PaymentReceiveAction.Create}
            a={AbilitySubject.PaymentReceive}
          >
            <Button
              intent={Intent.PRIMARY}
              large={true}
              onClick={() => {
                history.push('/payment-received/new');
              }}
            >
              <T id={'new_payment_received'} />
            </Button>

            {brandLinks.docs && (
              <Button
                intent={Intent.NONE}
                large={true}
                onClick={() =>
                  window.open(brandLinks.docs, '_blank', 'noopener,noreferrer')
                }
              >
                <T id={'learn_more'} />
              </Button>
            )}
          </Can>
        </>
      }
    />
  );
}
