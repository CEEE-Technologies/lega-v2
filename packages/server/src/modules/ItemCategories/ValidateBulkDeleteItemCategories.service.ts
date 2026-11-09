import { Injectable, Inject } from '@nestjs/common';
import { Knex } from 'knex';
import { TENANCY_DB_CONNECTION } from '../Tenancy/TenancyDB/TenancyDB.constants';
import { DeleteItemCategoryService } from './commands/DeleteItemCategory.service';
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
export class ValidateBulkDeleteItemCategoriesService {
  constructor(
    private readonly deleteItemCategoryService: DeleteItemCategoryService,
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
  ) {}

  public async validateBulkDeleteItemCategories(
    itemCategoryIds: number[],
  ): Promise<{
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

      for (const itemCategoryId of itemCategoryIds) {
        try {
          // A failed delete only undoes its own writes.
          await withSavepoint(trx, () =>
            this.deleteItemCategoryService.deleteItemCategory(
              itemCategoryId,
              trx,
            ),
          );
          deletableIds.push(itemCategoryId);
        } catch (error) {
          if (error instanceof TransactionAbortedError) throw error;
          nonDeletableIds.push(itemCategoryId);
          nonDeletableReasons.push(toNonDeletableReason(itemCategoryId, error));
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
