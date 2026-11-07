import { Injectable, Inject } from '@nestjs/common';
import { Knex } from 'knex';
import { TENANCY_DB_CONNECTION } from '../Tenancy/TenancyDB/TenancyDB.constants';
import { DeletePaymentReceivedService } from './commands/DeletePaymentReceived.service';
import {
  runDryRun,
  TransactionAbortedError,
  withSavepoint,
} from '@/modules/Tenancy/TenancyDB/DryRun';

@Injectable()
export class ValidateBulkDeletePaymentReceivedService {
  constructor(
    private readonly deletePaymentReceivedService: DeletePaymentReceivedService,
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
  ) {}

  public async validateBulkDeletePaymentReceived(
    paymentReceiveIds: number[],
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

      for (const paymentReceiveId of paymentReceiveIds) {
        try {
          // A failed delete only undoes its own writes.
          await withSavepoint(trx, () =>
            this.deletePaymentReceivedService.deletePaymentReceive(
              paymentReceiveId,
              trx,
            ),
          );
          deletableIds.push(paymentReceiveId);
        } catch (error) {
          if (error instanceof TransactionAbortedError) throw error;
          nonDeletableIds.push(paymentReceiveId);
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
