import {
  runAfterTransaction,
  settleAfterCommitWork,
} from './TransactionsHooks';

/**
 * settleAfterCommitWork waits for the after-commit work queued so far: a
 * CLI command that exits right after its last save no longer cuts it off.
 */
describe('settleAfterCommitWork', () => {
  const committed = () =>
    ({ executionPromise: Promise.resolve(), isCompleted: () => true }) as any;

  it('waits for the after-commit work, including work it queues in turn', async () => {
    const done: string[] = [];
    runAfterTransaction(committed(), async () => {
      await new Promise((r) => setTimeout(r, 50));
      done.push('first');
      runAfterTransaction(committed(), async () => {
        await new Promise((r) => setTimeout(r, 50));
        done.push('second');
      });
    });
    await settleAfterCommitWork();
    expect(done).toEqual(['first', 'second']);
  });

  it('does not wait for a rolled-back transaction, and gives up at the timeout', async () => {
    const rolledBack = Promise.reject(new Error('undone'));
    rolledBack.catch(() => undefined);
    const ran = jest.fn();
    runAfterTransaction({ executionPromise: rolledBack } as any, ran);
    await settleAfterCommitWork();
    expect(ran).not.toHaveBeenCalled();

    // A transaction that never ends.
    runAfterTransaction(
      { executionPromise: new Promise(() => {}) } as any,
      ran,
    );
    const started = Date.now();
    await settleAfterCommitWork(100);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
