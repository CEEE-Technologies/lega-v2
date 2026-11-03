import { Transaction } from 'objection';
import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
import { IsolationLevel } from './TransactionsHooks';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';

@Injectable()
export class UnitOfWork {
  constructor(
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKex: () => Knex,
  ) {}

  /**
   * Runs the given work inside a database transaction.
   *
   * When `trx` is given, the work joins that transaction and the caller
   * commits or rolls it back. Otherwise a new transaction is opened, and it
   * is committed (or rolled back on error) before this method returns, so a
   * caller never reports success for a save that has not been committed.
   *
   * Defaults to READ COMMITTED: other requests never see rows this
   * transaction has not committed yet.
   * @param {function} work - The work to be done in the transaction.
   * @param {Transaction} trx - An outer transaction to join.
   * @param {IsolationLevel} isolationLevel
   */
  public withTransaction = async <T>(
    work: (knex: Knex.Transaction) => Promise<T> | T,
    trx?: Transaction,
    isolationLevel: IsolationLevel = IsolationLevel.READ_COMMITTED,
  ): Promise<T> => {
    if (trx) {
      return work(trx);
    }
    const knex = this.tenantKex();
    const ownTrx = await knex.transaction({ isolationLevel });

    let result: T;
    try {
      result = await work(ownTrx);
    } catch (error) {
      if (!ownTrx.isCompleted()) {
        // Passing the error makes after-commit hooks (`runAfterTransaction`)
        // skip this transaction instead of running as if it had succeeded.
        await ownTrx.rollback(error).catch(() => undefined);
      }
      throw error;
    }
    // knex resolves `commit()` even when COMMIT fails; the failure only
    // shows up on `executionPromise`, so wait on that too.
    await ownTrx.commit();
    await ownTrx.executionPromise;
    return result;
  };
}
