import { Intent } from '@blueprintjs/core';
import intl from 'react-intl-universal';
import { AppToaster } from '@/components';
import { MATCHED_TRANSACTION_MESSAGE } from '@/constants/errors';

interface DeleteError {
  type: string;
  message?: string | null;
}

export const handleDeleteErrors = (errors: DeleteError[]): void => {
  const landedCost = errors.find(
    (e) => e.type === 'EXPENSE_HAS_ASSOCIATED_LANDED_COST',
  );
  if (landedCost) {
    // The server names the bill the landed cost was allocated to.
    AppToaster.show({
      intent: Intent.DANGER,
      message:
        landedCost.message ||
        intl.get(
          'couldn_t_delete_expense_transaction_has_associated_located_landed_cost_transaction',
        ),
    });
  }
  if (errors.find((e) => e.type === 'CANNOT_DELETE_TRANSACTION_MATCHED')) {
    AppToaster.show({
      intent: Intent.DANGER,
      message: MATCHED_TRANSACTION_MESSAGE,
    });
  }
};
