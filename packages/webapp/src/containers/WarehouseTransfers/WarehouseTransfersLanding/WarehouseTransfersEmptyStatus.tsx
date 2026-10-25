import { Button, Intent } from '@blueprintjs/core';
import React from 'react';
import { useHistory } from 'react-router-dom';
import { EmptyStatus, FormattedMessage as T } from '@/components';
import { brandLinks } from '@/constants/branding';

export function WarehouseTransfersEmptyStatus() {
  const history = useHistory();

  return (
    <EmptyStatus
      title={<T id={'warehouse_transfer.empty_status.title'} />}
      description={
        <p>
          <T id={'warehouse_transfer.empty_status.description'} />
        </p>
      }
      action={
        <>
          <Button
            intent={Intent.PRIMARY}
            large={true}
            onClick={() => {
              history.push('/warehouses-transfers/new');
            }}
          >
            <T id={'warehouse_transfer.action.new_warehouse_transfer'} />
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
        </>
      }
    />
  );
}
