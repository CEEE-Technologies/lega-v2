import { useCallback } from 'react';
import { DialogsName } from '@/constants/dialogs';
import { useDialogActions } from '@/hooks/state';

interface BulkDeleteValidationMutation {
  mutateAsync: (ids: number[]) => Promise<{
    deletableCount?: number;
    nonDeletableCount?: number;
    nonDeletableReasons?: Array<{ id: number; type: string; message: string }>;
  }>;
  isPending: boolean;
}

export const useBulkDeleteDialog = (
  dialogName: DialogsName,
  validateBulkDeleteMutation: BulkDeleteValidationMutation,
) => {
  const { openDialog, closeDialog } = useDialogActions();
  const { mutateAsync: validateBulkDelete, isPending } =
    validateBulkDeleteMutation;

  const openBulkDeleteDialog = useCallback(
    async (ids: number[]) => {
      if (!ids?.length) {
        return;
      }

      const {
        deletableCount = 0,
        nonDeletableCount = 0,
        nonDeletableReasons = [],
      } = await validateBulkDelete(ids);

      const totalSelected = deletableCount + nonDeletableCount || ids.length;

      openDialog(dialogName, {
        ids,
        deletableCount,
        undeletableCount: nonDeletableCount,
        // Why each one can't be deleted (shown in the dialog).
        nonDeletableReasons,
        totalSelected,
      });
    },
    [dialogName, openDialog, validateBulkDelete],
  );

  const closeBulkDeleteDialog = useCallback(() => {
    closeDialog(dialogName);
  }, [closeDialog, dialogName]);

  return {
    openBulkDeleteDialog,
    closeBulkDeleteDialog,
    isValidatingBulkDelete: isPending,
  };
};
