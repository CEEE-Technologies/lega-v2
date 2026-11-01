import { useFormikContext } from 'formik';
import { get } from 'lodash';
import { useEffect, useRef } from 'react';
import { transactionNumber } from '@/utils';

interface SyncAutoIncrementNumberOptions {
  /** The form field holding the document number. */
  fieldName: string;
  prefix?: string;
  nextNumber?: number | string;
  autoIncrement?: boolean;
  /** True on the "new document" page, false when editing. */
  isNewMode: boolean;
}

/**
 * Puts the next auto-increment number in a document form.
 *
 * - A new document gets the next number once the numbering settings have
 *   loaded (if the field is still empty), and again whenever they change.
 * - An existing document keeps its own number. It only takes the next number
 *   when the settings change while its number field is empty (the numbering
 *   dialog clears it when switching to auto-increment).
 * - Nothing happens while auto-increment is off or the settings are loading.
 */
export function useSyncAutoIncrementNumber({
  fieldName,
  prefix,
  nextNumber,
  autoIncrement,
  isNewMode,
}: SyncAutoIncrementNumberOptions) {
  const { values, setFieldValue } = useFormikContext<Record<string, unknown>>();
  const currentValue = get(values, fieldName);
  const isLoaded = nextNumber !== undefined && nextNumber !== null;
  const settingsKey = JSON.stringify([
    prefix ?? '',
    nextNumber ?? '',
    Boolean(autoIncrement),
  ]);
  // The settings the form last synced with (null until they load).
  const syncedKey = useRef<string | null>(null);

  useEffect(() => {
    if (!isLoaded) return;

    const isFirstLoad = syncedKey.current === null;
    if (syncedKey.current === settingsKey) return;
    syncedKey.current = settingsKey;

    if (!autoIncrement) return;

    const isEmpty = !currentValue;
    const shouldApply = isNewMode
      ? !isFirstLoad || isEmpty
      : !isFirstLoad && isEmpty;

    if (shouldApply) {
      setFieldValue(fieldName, transactionNumber(prefix, nextNumber));
    }
    // Only the settings trigger a sync, not typing in the number field.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsKey, isLoaded]);
}
