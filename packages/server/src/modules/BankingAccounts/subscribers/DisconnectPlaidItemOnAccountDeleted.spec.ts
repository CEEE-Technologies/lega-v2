import { DisconnectPlaidItemOnAccountDeleted } from './DisconnectPlaidItemOnAccountDeleted';
import { DryRunRollback } from '@/modules/Tenancy/TenancyDB/DryRun';

/**
 * E3: the Plaid disconnect must only run once the account delete has been
 * committed. A dry run (bulk-delete check) or a delete that fails later
 * must leave the bank connection alone.
 */
describe('DisconnectPlaidItemOnAccountDeleted', () => {
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  /** A query builder stub: every call chains, awaiting it gives `result`. */
  const builder = (result: unknown) => {
    const b: any = {};
    for (const m of ['query', 'findOne', 'where', 'patch', 'delete']) {
      b[m] = jest.fn(() => b);
    }
    b.then = (resolve: (v: unknown) => void) => resolve(result);
    return b;
  };

  const setup = () => {
    const plaidClient = { itemRemove: jest.fn().mockResolvedValue({}) };
    const plaidItemQuery = builder({ plaidAccessToken: 'access-token' });
    const accountQuery = builder(1);
    const subscriber = new DisconnectPlaidItemOnAccountDeleted(
      plaidClient as any,
      (() => plaidItemQuery) as any,
      (() => accountQuery) as any,
    );
    return { plaidClient, subscriber, plaidItemQuery, accountQuery };
  };

  /** A transaction stub whose outcome the test decides. */
  const fakeTrx = () => {
    let resolve: () => void;
    let reject: (e: Error) => void;
    const executionPromise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    // Like knex: a rollback nobody waits for is not an unhandled rejection.
    executionPromise.catch(() => undefined);
    return {
      trx: { executionPromise } as any,
      commit: () => resolve(),
      rollback: (e: Error) => reject(e),
    };
  };

  const payload = (trx: any) => ({
    accountId: 1,
    oldAccount: { id: 1, plaidItemId: 'item-1' } as any,
    trx,
  });

  it('makes no Plaid call in a dry run', async () => {
    const { plaidClient, subscriber } = setup();
    const { trx, rollback } = fakeTrx();

    await subscriber.handleDisconnectPlaidItemOnAccountDelete(payload(trx));
    rollback(new DryRunRollback());
    await flush();

    expect(plaidClient.itemRemove).not.toHaveBeenCalled();
  });

  it('makes no Plaid call when the delete fails after this step', async () => {
    const { plaidClient, subscriber } = setup();
    const { trx, rollback } = fakeTrx();

    await subscriber.handleDisconnectPlaidItemOnAccountDelete(payload(trx));
    rollback(new Error('a later handler failed'));
    await flush();

    expect(plaidClient.itemRemove).not.toHaveBeenCalled();
  });

  it('disconnects Plaid once the delete is committed', async () => {
    const { plaidClient, subscriber } = setup();
    const { trx, commit } = fakeTrx();

    await subscriber.handleDisconnectPlaidItemOnAccountDelete(payload(trx));
    expect(plaidClient.itemRemove).not.toHaveBeenCalled();

    commit();
    await flush();

    expect(plaidClient.itemRemove).toHaveBeenCalledTimes(1);
    expect(plaidClient.itemRemove).toHaveBeenCalledWith({
      access_token: 'access-token',
    });
  });

  it('unlinks the accounts and removes the Plaid item inside the delete', async () => {
    const { subscriber, accountQuery, plaidItemQuery } = setup();
    const { trx } = fakeTrx();

    await subscriber.handleDisconnectPlaidItemOnAccountDelete(payload(trx));

    expect(accountQuery.query).toHaveBeenCalledWith(trx);
    expect(accountQuery.patch).toHaveBeenCalledWith({
      plaidAccountId: null,
      plaidItemId: null,
    });
    expect(plaidItemQuery.delete).toHaveBeenCalled();
  });

  it('does not fail the delete when Plaid refuses the disconnect', async () => {
    const { plaidClient, subscriber } = setup();
    plaidClient.itemRemove.mockRejectedValue(new Error('plaid down'));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { trx, commit } = fakeTrx();

    await expect(
      subscriber.handleDisconnectPlaidItemOnAccountDelete(payload(trx)),
    ).resolves.toBeUndefined();
    commit();
    await flush();
    await flush();

    expect(plaidClient.itemRemove).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('does nothing for an account not linked to Plaid', async () => {
    const { plaidClient, subscriber, accountQuery } = setup();
    const { trx, commit } = fakeTrx();

    await subscriber.handleDisconnectPlaidItemOnAccountDelete({
      ...payload(trx),
      oldAccount: { id: 1, plaidItemId: null } as any,
    });
    commit();
    await flush();

    expect(accountQuery.patch).not.toHaveBeenCalled();
    expect(plaidClient.itemRemove).not.toHaveBeenCalled();
  });
});
