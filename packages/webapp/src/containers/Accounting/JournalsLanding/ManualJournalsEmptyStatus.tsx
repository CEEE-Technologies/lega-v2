import { Button, Intent } from '@blueprintjs/core';
import React from 'react';
import { useHistory } from 'react-router-dom';
import { Can, FormattedMessage as T, EmptyStatus } from '@/components';
import { AbilitySubject, ManualJournalAction } from '@/constants/abilityOption';
import { brandLinks } from '@/constants/branding';

export function ManualJournalsEmptyStatus() {
  const history = useHistory();

  return (
    <EmptyStatus
      title={<T id={'manual_journals.empty_status.title'} />}
      description={
        <p>
          <T id={'manual_journals.empty_status.description'} />
        </p>
      }
      action={
        <>
          <Can I={ManualJournalAction.Create} a={AbilitySubject.ManualJournal}>
            <Button
              intent={Intent.PRIMARY}
              large={true}
              onClick={() => {
                history.push('/make-journal-entry');
              }}
            >
              <T id={'make_journal'} />
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
