import { Inject, Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { TENANCY_DB_CONNECTION } from '../Tenancy/TenancyDB/TenancyDB.constants';
import { DeleteCustomer } from './commands/DeleteCustomer.service';
import { ModelHasRelationsError } from '@/common/exceptions/ModelHasRelations.exception';
import { ServiceError } from '@/modules/Items/ServiceError';
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
export class ValidateBulkDeleteCustomersService {
  constructor(
    private readonly deleteCustomerService: DeleteCustomer,
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
  ) {}

  public async validateBulkDeleteCustomers(customerIds: number[]): Promise<{
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

      for (const customerId of customerIds) {
        try {
          // A failed delete only undoes its own writes.
          await withSavepoint(trx, () =>
            this.deleteCustomerService.deleteCustomer(customerId, trx),
          );
          deletableIds.push(customerId);
        } catch (error) {
          if (error instanceof TransactionAbortedError) throw error;
          if (
            error instanceof ModelHasRelationsError ||
            (error instanceof ServiceError &&
              error.errorType === 'CUSTOMER_HAS_TRANSACTIONS')
          ) {
            nonDeletableIds.push(customerId);
            nonDeletableReasons.push(toNonDeletableReason(customerId, error));
          } else {
            nonDeletableIds.push(customerId);
            nonDeletableReasons.push(toNonDeletableReason(customerId, error));
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
