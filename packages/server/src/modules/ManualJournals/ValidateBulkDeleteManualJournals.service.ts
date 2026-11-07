import { Injectable, Inject } from '@nestjs/common';
import { Knex } from 'knex';
import { TENANCY_DB_CONNECTION } from '../Tenancy/TenancyDB/TenancyDB.constants';
import { DeleteManualJournalService } from './commands/DeleteManualJournal.service';
import {
  runDryRun,
  TransactionAbortedError,
  withSavepoint,
} from '@/modules/Tenancy/TenancyDB/DryRun';

@Injectable()
export class ValidateBulkDeleteManualJournalsService {
  constructor(
    private readonly deleteManualJournalService: DeleteManualJournalService,
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
  ) {}

  public async validateBulkDeleteManualJournals(
    manualJournalIds: number[],
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

      for (const manualJournalId of manualJournalIds) {
        try {
          // A failed delete only undoes its own writes.
          await withSavepoint(trx, () =>
            this.deleteManualJournalService.deleteManualJournal(
              manualJournalId,
              trx,
            ),
          );
          deletableIds.push(manualJournalId);
        } catch (error) {
          if (error instanceof TransactionAbortedError) throw error;
          nonDeletableIds.push(manualJournalId);
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
