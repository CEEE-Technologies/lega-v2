import { ServiceError } from '@/modules/Items/ServiceError';
import { ModelHasRelationsError } from '@/common/exceptions/ModelHasRelations.exception';

/** Why one record of a bulk delete can't be deleted. */
export interface NonDeletableReason {
  id: number;
  type: string;
  message: string;
}

/**
 * The reason a bulk-delete check gives for a record its delete refused:
 * the service's own error type and message. An unexpected error gets a
 * plain message (its text may be a database error).
 * @param {number} id - The record.
 * @param {unknown} error - What its delete threw.
 */
export const toNonDeletableReason = (
  id: number,
  error: unknown,
): NonDeletableReason => {
  if (error instanceof ServiceError) {
    return {
      id,
      type: error.errorType,
      message: error.message || 'It cannot be deleted.',
    };
  }
  if (error instanceof ModelHasRelationsError) {
    return {
      id,
      type: error.type,
      message:
        error.message && error.message !== 'Entity has relations'
          ? error.message
          : 'It is used by other transactions.',
    };
  }
  return { id, type: 'UNKNOWN', message: 'It could not be deleted.' };
};
