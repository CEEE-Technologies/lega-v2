import { Knex } from 'knex';
import { IsolationLevel } from './TransactionsHooks';

/**
 * The reason a dry run gives when it undoes its transaction.
 *
 * knex treats `rollback()` with no reason as a normal finish, so work
 * waiting for the commit (`runAfterTransaction`) would still run. Rolling
 * back with this error makes that work skip the dry run.
 */
export class DryRunRollback extends Error {
  constructor() {
    super('Dry run: the transaction is always rolled back.');
    this.name = 'DryRunRollback';
  }
}

/**
 * Runs the given work in a transaction that is always rolled back, whether
 * the work succeeds or fails. Use it for previews and "can this be done?"
 * checks: nothing they write is kept, and no after-commit work runs.
 * @param {() => Knex} knex - Returns the tenant knex instance.
 * @param {(trx: Knex.Transaction) => Promise<T>} work
 * @returns {Promise<T>} What the work returned.
 */
export const runDryRun = async <T>(
  knex: Knex,
  work: (trx: Knex.Transaction) => Promise<T>,
  isolationLevel: IsolationLevel = IsolationLevel.READ_COMMITTED,
): Promise<T> => {
  const trx = await knex.transaction({ isolationLevel });
  try {
    return await work(trx);
  } finally {
    if (!trx.isCompleted()) {
      await trx.rollback(new DryRunRollback()).catch(() => undefined);
    }
  }
};

let savepointCounter = 0;

/**
 * Runs one step of a larger transaction inside a savepoint. If the step
 * fails, only its own writes are undone and the error is passed on; the
 * outer transaction stays usable for the next step.
 *
 * The step gets the outer transaction itself (not a nested knex
 * transaction), so after-commit work it registers still waits for the
 * outer commit. Steps must run one at a time on the transaction.
 * @param {Knex.Transaction} trx - The outer transaction.
 * @param {() => Promise<T>} step
 * @returns {Promise<T>}
 */
export const withSavepoint = async <T>(
  trx: Knex.Transaction,
  step: () => Promise<T>,
): Promise<T> => {
  savepointCounter = (savepointCounter + 1) % 1_000_000;
  const name = `lega_step_${savepointCounter}`;

  await trx.raw(`SAVEPOINT ${name}`);
  try {
    const result = await step();
    await trx.raw(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    try {
      await trx.raw(`ROLLBACK TO SAVEPOINT ${name}`);
    } catch {
      // The savepoint is gone: the database already undid the whole
      // transaction (for example after a deadlock). Later steps would run
      // outside any transaction, so the caller must stop.
      throw new TransactionAbortedError(error);
    }
    throw error;
  }
};

/**
 * The database undid the whole transaction while a step was running, so the
 * outer work can't go on. Loops that catch step errors must pass it on.
 */
export class TransactionAbortedError extends Error {
  constructor(public readonly stepError: unknown) {
    super(
      `The transaction was undone by the database: ${
        stepError instanceof Error ? stepError.message : String(stepError)
      }`,
    );
    this.name = 'TransactionAbortedError';
  }
}
