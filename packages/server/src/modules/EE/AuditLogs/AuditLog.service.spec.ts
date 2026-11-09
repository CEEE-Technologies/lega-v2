import { AuditLogService } from './AuditLog.service';

/**
 * The audit row is written after the save commits, never with the save's
 * transaction. Written with it, a deadlock on the audit insert made the
 * database undo the whole save while the save carried on (the handler
 * ignores errors), so the ledger and stock rows of an undone bill were kept.
 */
describe('AuditLogService.record', () => {
  const deadlock = Object.assign(new Error('Deadlock found'), {
    errno: 1213,
    code: 'ER_LOCK_DEADLOCK',
  });

  /** A transaction whose end the test decides. */
  const fakeTrx = () => {
    let commit!: () => void;
    let rollback!: (error: Error) => void;
    const executionPromise = new Promise<void>((resolve, reject) => {
      commit = resolve;
      rollback = reject;
    });
    // Keep an unhandled rejection from failing the run.
    executionPromise.catch(() => undefined);
    const trx = {
      executionPromise,
      isCompleted: () => false,
    } as any;
    return { trx, commit, rollback };
  };

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  const setup = (insertImpl?: () => Promise<unknown>) => {
    const insert = jest.fn((_row: Record<string, unknown>) =>
      (insertImpl ?? (() => Promise.resolve({})))(),
    );
    const query = jest.fn(() => ({ insert }));
    const knex = { name: 'tenant knex' };
    const context: Record<string, unknown> = { userId: 7, ip: '10.0.0.1' };
    const cls = { get: jest.fn((key: string) => context[key]) };
    const service = new AuditLogService(
      cls as any,
      (() => ({ query })) as any,
      (() => knex) as any,
    );
    return { service, insert, query, knex, context };
  };

  it('does not write with the save transaction, and writes once it commits', async () => {
    const { service, insert, query, knex } = setup();
    const { trx, commit } = fakeTrx();

    await service.record({
      trx,
      action: 'created',
      subject: 'Bill',
      subjectId: 42,
      metadata: { amount: 500 },
    });
    await flush();
    expect(insert).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalledWith(trx);

    commit();
    await flush();
    expect(query).toHaveBeenCalledWith(knex);
    expect(insert).toHaveBeenCalledTimes(1);
    expect(insert.mock.calls[0][0]).toMatchObject({
      userId: 7,
      ip: '10.0.0.1',
      action: 'created',
      subject: 'Bill',
      subjectId: 42,
      metadata: { amount: 500 },
    });
  });

  it('writes nothing when the save is undone', async () => {
    const { service, insert } = setup();
    const { trx, rollback } = fakeTrx();

    await service.record({ trx, action: 'created', subject: 'Bill' });
    rollback(new Error('save failed'));
    await flush();
    expect(insert).not.toHaveBeenCalled();
  });

  it('a deadlock on the audit insert does not fail the save', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { service, insert } = setup(() => Promise.reject(deadlock));
      const { trx, commit } = fakeTrx();

      await expect(
        service.record({ trx, action: 'created', subject: 'Bill' }),
      ).resolves.toBeUndefined();
      commit();
      await flush();
      expect(insert).toHaveBeenCalledTimes(1);
      expect(errors).toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it('keeps the user who made the save even if the context is gone by the commit', async () => {
    const { service, insert, context } = setup();
    const { trx, commit } = fakeTrx();

    await service.record({ trx, action: 'edited', subject: 'Bill' });
    context.userId = undefined;
    context.ip = undefined;
    commit();
    await flush();
    expect(insert.mock.calls[0][0]).toMatchObject({
      userId: 7,
      ip: '10.0.0.1',
    });
  });

  it('without a transaction, writes straight away', async () => {
    const { service, insert } = setup();
    await service.record({ action: 'activated', subject: 'Account' });
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
