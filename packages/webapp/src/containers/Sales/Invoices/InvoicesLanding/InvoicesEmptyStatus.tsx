import { Button, Intent } from '@blueprintjs/core';
import React from 'react';
import { useHistory } from 'react-router-dom';
import { EmptyStatus, Can, FormattedMessage as T } from '@/components';
import { SaleInvoiceAction, AbilitySubject } from '@/constants/abilityOption';
import { brandLinks } from '@/constants/branding';

export function InvoicesEmptyStatus() {
  const history = useHistory();

  return (
    <EmptyStatus
      title={<T id={'the_organization_doesn_t_receive_money_yet'} />}
      description={
        <p>
          <T id={'invoices_empty_status_description'} />
        </p>
      }
      action={
        <>
          <Can I={SaleInvoiceAction.Create} a={AbilitySubject.Invoice}>
            <Button
              intent={Intent.PRIMARY}
              large={true}
              onClick={() => {
                history.push('/invoices/new');
              }}
            >
              <T id={'new_sale_invoice'} />
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
