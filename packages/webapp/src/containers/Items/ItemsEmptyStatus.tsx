import { Button, Intent } from '@blueprintjs/core';
import React from 'react';
import { useHistory } from 'react-router-dom';
import { Can, FormattedMessage as T, EmptyStatus } from '@/components';
import { ItemAction, AbilitySubject } from '@/constants/abilityOption';
import { brandLinks } from '@/constants/branding';

export function ItemsEmptyStatus() {
  const history = useHistory();

  return (
    <EmptyStatus
      title={<T id={'manage_the_organization_s_services_and_products'} />}
      description={
        <p>
          <T id={'here_a_list_of_your_organization_products_and_services'} />
        </p>
      }
      action={
        <>
          <Can I={ItemAction.Create} a={AbilitySubject.Item}>
            <Button
              intent={Intent.PRIMARY}
              large={true}
              onClick={() => {
                history.push('/items/new');
              }}
            >
              <T id={'new_item'} />
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
