import { Intent } from '@blueprintjs/core';
import { AppToaster } from '@/components';
import { MATCHED_TRANSACTION_MESSAGE } from '@/constants/errors';

interface DeleteError {
  type: string;
}

export const handleDeleteErrors = (errors: DeleteError[]): void => {
  if (errors.find((e) => e.type === 'CANNOT_DELETE_TRANSACTION_MATCHED')) {
    AppToaster.show({
      intent: Intent.DANGER,
      message: MATCHED_TRANSACTION_MESSAGE,
    });
  }
};
