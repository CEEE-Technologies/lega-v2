import { Injectable, Inject } from '@nestjs/common';
import { Knex } from 'knex';
import { TENANCY_DB_CONNECTION } from '../Tenancy/TenancyDB/TenancyDB.constants';
import { DeleteSaleInvoice } from './commands/DeleteSaleInvoice.service';
import {
  runDryRun,
  TransactionAbortedError,
  withSavepoint,
} from '@/modules/Tenancy/TenancyDB/DryRun';

@Injectable()
export class ValidateBulkDeleteSaleInvoicesService {
  constructor(
    private readonly deleteSaleInvoiceService: DeleteSaleInvoice,
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
  ) {}

  public async validateBulkDeleteSaleInvoices(
    saleInvoiceIds: number[],
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

      for (const saleInvoiceId of saleInvoiceIds) {
        try {
          // A failed delete only undoes its own writes.
          await withSavepoint(trx, () =>
            this.deleteSaleInvoiceService.deleteSaleInvoice(saleInvoiceId, trx),
          );
          deletableIds.push(saleInvoiceId);
        } catch (error) {
          if (error instanceof TransactionAbortedError) throw error;
          nonDeletableIds.push(saleInvoiceId);
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
