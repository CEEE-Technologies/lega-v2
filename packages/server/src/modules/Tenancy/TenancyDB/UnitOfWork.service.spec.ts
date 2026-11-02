import { UnitOfWork } from './UnitOfWork.service';
import { IsolationLevel, runAfterTransaction } from './TransactionsHooks';

const deferred = () => {
  let resolve: (value?: any) => void;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

/** A fake knex transaction that records what happened, in order. */
const fakeTrx = (opts: { commitFails?: Error } = {}) => {
  const log: string[] = [];
  let completed = false;
  let settle: { resolve: (v?: any) => void; reject: (e: any) => void };
  const executionPromise = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  executionPromise.catch(() => undefined);
  const commitGate = deferred();
  const trx: any = {
    log,
    commitGate,
    executionPromise,
    isCompleted: () => completed,
    // Like knex: commit() resolves even when COMMIT fails; only
    // executionPromise rejects.
    commit: jest.fn(async () => {
      await commitGate.promise;
      completed = true;
      log.push('commit');
      if (opts.commitFails) settle.reject(opts.commitFails);
      else settle.resolve();
    }),
    rollback: jest.fn(async (error?: any) => {
      completed = true;
      log.push('rollback');
      if (error) settle.reject(error);
      else settle.resolve();
    }),
  };
  return trx;
};

const unitOfWorkWith = (trx: any) => {
  const transaction = jest.fn().mockResolvedValue(trx);
  const uow = new UnitOfWork((() => ({ transaction })) as any);
  return { uow, transaction };
};

describe('UnitOfWork.withTransaction', () => {
  it('defaults to READ COMMITTED', async () => {
    const trx = fakeTrx();
    trx.commitGate.resolve();
    const { uow, transaction } = unitOfWorkWith(trx);

    await uow.withTransaction(async () => 1);
    expect(transaction).toHaveBeenCalledWith({
      isolationLevel: IsolationLevel.READ_COMMITTED,
    });
    expect(IsolationLevel.READ_COMMITTED).toBe('read committed');
  });

  it('returns only after the commit has finished', async () => {
    const trx = fakeTrx();
    const { uow } = unitOfWorkWith(trx);
    let returned = false;

    const pending = uow
      .withTransaction(async () => 'saved')
      .then((value) => {
        returned = true;
        return value;
      });
    await new Promise((r) => setImmediate(r));
    expect(trx.commit).toHaveBeenCalled();
    expect(returned).toBe(false);

    trx.commitGate.resolve();
    await expect(pending).resolves.toBe('saved');
    expect(trx.log).toEqual(['commit']);
  });

  it('a failed commit fails the call', async () => {
    const trx = fakeTrx({ commitFails: new Error('Deadlock found') });
    trx.commitGate.resolve();
    const { uow } = unitOfWorkWith(trx);

    await expect(uow.withTransaction(async () => 'saved')).rejects.toThrow(
      'Deadlock found',
    );
  });

  it('rolls back (and waits) when the work throws', async () => {
    const trx = fakeTrx();
    const { uow } = unitOfWorkWith(trx);
    const error = new Error('Validation failed');

    await expect(
      uow.withTransaction(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
    expect(trx.rollback).toHaveBeenCalledWith(error);
    expect(trx.commit).not.toHaveBeenCalled();
    // The rollback is reported to after-commit hooks as a failure.
    await expect(trx.executionPromise).rejects.toBe(error);
  });

  it('joins an outer transaction without committing it', async () => {
    const outer = fakeTrx();
    const { uow, transaction } = unitOfWorkWith(fakeTrx());

    await expect(uow.withTransaction(async (t) => t, outer)).resolves.toBe(
      outer,
    );
    expect(transaction).not.toHaveBeenCalled();
    expect(outer.commit).not.toHaveBeenCalled();
    expect(outer.rollback).not.toHaveBeenCalled();
  });
});

describe('runAfterTransaction', () => {
  it('runs the hook after commit, not after a rollback', async () => {
    const committed = fakeTrx();
    committed.commitGate.resolve();
    const rolledBack = fakeTrx();
    const hook = jest.fn();
    const skipped = jest.fn();

    runAfterTransaction(committed, hook);
    runAfterTransaction(rolledBack, skipped);
    expect(hook).not.toHaveBeenCalled();

    await committed.commit();
    await rolledBack.rollback(new Error('failed'));
    await new Promise((r) => setImmediate(r));

    expect(hook).toHaveBeenCalledTimes(1);
    expect(skipped).not.toHaveBeenCalled();
  });

  it('logs a failing hook instead of throwing it', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] });
    const errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const trx = fakeTrx();
      trx.commitGate.resolve();
      runAfterTransaction(trx, async () => {
        throw new Error('SMS gateway down');
      });
      await trx.commit();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      // Nothing is scheduled to re-throw it later.
      expect(jest.getTimerCount()).toBe(0);
      expect(errorLog).toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
      jest.useRealTimers();
    }
  });
});
