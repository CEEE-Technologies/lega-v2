import { Injectable, Inject } from '@nestjs/common';
import { Knex } from 'knex';
import { TENANCY_DB_CONNECTION } from '../Tenancy/TenancyDB/TenancyDB.constants';
import { DeleteWarehouseTransfer } from './commands/DeleteWarehouseTransfer';
import {
  runDryRun,
  TransactionAbortedError,
  withSavepoint,
} from '@/modules/Tenancy/TenancyDB/DryRun';

@Injectable()
export class ValidateBulkDeleteWarehouseTransfersService {
  constructor(
    private readonly deleteWarehouseTransferService: DeleteWarehouseTransfer,
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
  ) {}

  public async validateBulkDeleteWarehouseTransfers(
    warehouseTransferIds: number[],
  ): Promise<{
    deletableCount: number;
    nonDeletableCount: number;
    deletableIds: number[];
    nonDeletableIds: number[];
  }> {
    // Every delete runs in a transaction that is always rolled back, so
    // nothing is kept and no after-save work runs.
    return runDryRun(this.tenantKnex(), async (trx) => {
      const deletableIds: number[] = [];
      const nonDeletableIds: number[] = [];

      for (const warehouseTransferId of warehouseTransferIds) {
        try {
          // A failed delete only undoes its own writes.
          await withSavepoint(trx, () =>
            this.deleteWarehouseTransferService.deleteWarehouseTransfer(
              warehouseTransferId,
              trx,
            ),
          );
          deletableIds.push(warehouseTransferId);
        } catch (error) {
          if (error instanceof TransactionAbortedError) throw error;
          nonDeletableIds.push(warehouseTransferId);
        }
      }

      return {
        deletableCount: deletableIds.length,
        nonDeletableCount: nonDeletableIds.length,
        deletableIds,
        nonDeletableIds,
      };
    });
  }
}
