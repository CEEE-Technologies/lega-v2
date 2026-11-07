import { Injectable, Inject } from '@nestjs/common';
import { Knex } from 'knex';
import { TENANCY_DB_CONNECTION } from '../Tenancy/TenancyDB/TenancyDB.constants';
import { DeleteBillPayment } from './commands/DeleteBillPayment.service';
import {
  runDryRun,
  TransactionAbortedError,
  withSavepoint,
} from '@/modules/Tenancy/TenancyDB/DryRun';

@Injectable()
export class ValidateBulkDeleteBillPaymentsService {
  constructor(
    private readonly deleteBillPaymentService: DeleteBillPayment,
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
  ) {}

  public async validateBulkDeleteBillPayments(
    billPaymentIds: number[],
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

      for (const billPaymentId of billPaymentIds) {
        try {
          // A failed delete only undoes its own writes.
          await withSavepoint(trx, () =>
            this.deleteBillPaymentService.deleteBillPayment(billPaymentId, trx),
          );
          deletableIds.push(billPaymentId);
        } catch (error) {
          if (error instanceof TransactionAbortedError) throw error;
          nonDeletableIds.push(billPaymentId);
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
