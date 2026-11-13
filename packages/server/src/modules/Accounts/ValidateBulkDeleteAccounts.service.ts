import { Injectable, Inject } from '@nestjs/common';
import { Knex } from 'knex';
import { TENANCY_DB_CONNECTION } from '../Tenancy/TenancyDB/TenancyDB.constants';
import { DeleteAccount } from './DeleteAccount.service';
import { ModelHasRelationsError } from '@/common/exceptions/ModelHasRelations.exception';
import {
  runDryRun,
  TransactionAbortedError,
  withSavepoint,
} from '@/modules/Tenancy/TenancyDB/DryRun';
import {
  NonDeletableReason,
  toNonDeletableReason,
} from '@/common/utils/non-deletable-reason';

@Injectable()
export class ValidateBulkDeleteAccountsService {
  constructor(
    private readonly deleteAccountService: DeleteAccount,
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
  ) {}

  /**
   * Validates which accounts from the provided IDs can be deleted.
   * Uses the actual deleteAccount service to validate, ensuring the same validation logic.
   * Uses a transaction that is always rolled back to ensure no database changes.
   * @param {number[]} accountIds - Array of account IDs to validate
   * @returns {Promise<{deletableCount: number, nonDeletableCount: number, deletableIds: number[], nonDeletableIds: number[]}>}
   */
  public async validateBulkDeleteAccounts(accountIds: number[]): Promise<{
    deletableCount: number;
    nonDeletableCount: number;
    deletableIds: number[];
    nonDeletableIds: number[];
    nonDeletableReasons?: NonDeletableReason[];
  }> {
    // Every delete runs in a transaction that is always rolled back, so
    // nothing is kept and no after-save work runs.
    return runDryRun(this.tenantKnex(), async (trx) => {
      const deletableIds: number[] = [];
      const nonDeletableIds: number[] = [];
      const nonDeletableReasons: NonDeletableReason[] = [];

      for (const accountId of accountIds) {
        try {
          // A failed delete only undoes its own writes.
          await withSavepoint(trx, () =>
            this.deleteAccountService.deleteAccount(accountId, trx),
          );
          deletableIds.push(accountId);
        } catch (error) {
          if (error instanceof TransactionAbortedError) throw error;
          if (error instanceof ModelHasRelationsError) {
            nonDeletableIds.push(accountId);
            nonDeletableReasons.push(toNonDeletableReason(accountId, error));
          } else {
            nonDeletableIds.push(accountId);
            nonDeletableReasons.push(toNonDeletableReason(accountId, error));
          }
        }
      }

      return {
        deletableCount: deletableIds.length,
        nonDeletableCount: nonDeletableIds.length,
        deletableIds,
        nonDeletableIds,
        nonDeletableReasons,
      };
    });
  }
}
