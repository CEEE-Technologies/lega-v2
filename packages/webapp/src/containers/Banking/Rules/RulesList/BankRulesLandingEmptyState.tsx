import { Button, Intent } from '@blueprintjs/core';
import * as FF from 'fp-ts/function';
import styles from './BankRulesLandingEmptyState.module.scss';
import type { WithDialogActionsProps } from '@/containers/Dialog/withDialogActions';
import { EmptyStatus, Can, FormattedMessage as T } from '@/components';
import { AbilitySubject, BankRuleAction } from '@/constants/abilityOption';
import { brandLinks } from '@/constants/branding';
import { DialogsName } from '@/constants/dialogs';
import { withDialogActions } from '@/containers/Dialog/withDialogActions';

function BankRulesLandingEmptyStateRoot({
  // #withDialogAction
  openDialog,
}: WithDialogActionsProps) {
  const handleNewBtnClick = () => {
    openDialog(DialogsName.BankRuleForm);
  };

  return (
    <EmptyStatus
      title={'Create rules to categorize bank transactions automatically'}
      description={
        <p>
          Bank rules will run automatically to categorize the incoming bank
          transactions under the conditions you set up.
        </p>
      }
      action={
        <>
          <Can I={BankRuleAction.Create} a={AbilitySubject.BankRule}>
            <Button
              intent={Intent.PRIMARY}
              large={true}
              onClick={handleNewBtnClick}
            >
              New Bank Rule
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
      classNames={{ root: styles.root }}
    />
  );
}

export const BankRulesLandingEmptyState = FF.pipe(
  BankRulesLandingEmptyStateRoot,
  withDialogActions,
);
