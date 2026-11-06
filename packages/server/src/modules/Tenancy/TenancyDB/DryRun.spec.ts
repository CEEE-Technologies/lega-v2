import {
  DryRunRollback,
  runDryRun,
  TransactionAbortedError,
  withSavepoint,
} from './DryRun';

describe('runDryRun', () => {
  const fakeKnex = () => {
    const trx = {
      completed: false,
      rollback: jest.fn(async function (this: any, _reason?: unknown) {
        trx.completed = true;
      }),
      isCompleted: () => trx.completed,
    };
    const knex = { transaction: jest.fn(async () => trx) };
    return { knex: knex as any, trx };
  };

  it('rolls back with a dry-run reason after the work succeeds', async () => {
    const { knex, trx } = fakeKnex();
    await expect(runDryRun(knex, async () => 'result')).resolves.toBe('result');
    expect(trx.rollback).toHaveBeenCalledTimes(1);
    expect(trx.rollback.mock.calls[0][0]).toBeInstanceOf(DryRunRollback);
  });

  it('rolls back and passes the error on when the work fails', async () => {
    const { knex, trx } = fakeKnex();
    await expect(
      runDryRun(knex, async () => {
        throw new Error('file not mapped');
      }),
    ).rejects.toThrow('file not mapped');
    expect(trx.rollback).toHaveBeenCalledTimes(1);
    expect(trx.rollback.mock.calls[0][0]).toBeInstanceOf(DryRunRollback);
  });

  it('opens the transaction as read committed', async () => {
    const { knex } = fakeKnex();
    await runDryRun(knex, async () => undefined);
    expect(knex.transaction).toHaveBeenCalledWith({
      isolationLevel: 'read committed',
    });
  });
});

describe('withSavepoint', () => {
  const fakeTrx = (failRollbackTo = false) => {
    const sql: string[] = [];
    const trx = {
      raw: jest.fn(async (statement: string) => {
        sql.push(statement.replace(/lega_step_\d+/, 'sp'));
        if (failRollbackTo && statement.startsWith('ROLLBACK TO')) {
          throw new Error('SAVEPOINT does not exist');
        }
      }),
    };
    return { trx: trx as any, sql };
  };

  it('releases the savepoint when the step succeeds', async () => {
    const { trx, sql } = fakeTrx();
    await expect(withSavepoint(trx, async () => 42)).resolves.toBe(42);
    expect(sql).toEqual(['SAVEPOINT sp', 'RELEASE SAVEPOINT sp']);
  });

  it('undoes only the step when it fails, and passes the error on', async () => {
    const { trx, sql } = fakeTrx();
    await expect(
      withSavepoint(trx, async () => {
        throw new Error('locked period');
      }),
    ).rejects.toThrow('locked period');
    expect(sql).toEqual(['SAVEPOINT sp', 'ROLLBACK TO SAVEPOINT sp']);
  });

  it('reports a lost transaction when the savepoint is gone', async () => {
    const { trx } = fakeTrx(true);
    await expect(
      withSavepoint(trx, async () => {
        throw new Error('Deadlock found');
      }),
    ).rejects.toBeInstanceOf(TransactionAbortedError);
  });
});
