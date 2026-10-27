import { TransactionsLockingGuard } from './TransactionsLockingGuard';
import {
  LINKED_TRANSACTIONS_DATE_LOCKED,
  LinkedTransactionsLockingGuard,
} from './LinkedTransactionsLockingGuard';
import { TransactionsLockingGroup } from '../types/TransactionsLocking.types';

describe('LinkedTransactionsLockingGuard', () => {
  const buildGuard = (
    locking: Record<string, any>,
    lockingType: string = TransactionsLockingGroup.All,
  ) => {
    const repo = {
      getTransactionsLocking: jest.fn().mockResolvedValue(locking),
      getTransactionsLockingType: jest.fn().mockResolvedValue(lockingType),
    };
    const guard = new LinkedTransactionsLockingGuard(
      new TransactionsLockingGuard(repo as any),
      repo as any,
    );
    return { guard, repo };
  };
  const lockedToMarch = { isEnabled: true, lockToDate: '2026-03-31' };

  it('blocks the edit and names the payment dated inside the locked period', async () => {
    const { guard } = buildGuard(lockedToMarch);

    const promise = guard.validateLinkedTransactionsNotLocked(
      [
        { label: 'PAY-5', date: '2026-03-28' },
        { label: 'PAY-9', date: '2026-04-02' },
      ],
      TransactionsLockingGroup.Purchases,
      'this bill',
    );
    await expect(promise).rejects.toMatchObject({
      errorType: LINKED_TRANSACTIONS_DATE_LOCKED,
      payload: {
        transactions: [{ label: 'PAY-5', date: '2026-03-28' }],
      },
    });
    await expect(promise).rejects.toThrow(
      /PAY-5 \(28 Mar 2026\) is linked to this bill/,
    );
  });

  it('allows the edit when every linked transaction is after the lock date', async () => {
    const { guard } = buildGuard(lockedToMarch);

    await expect(
      guard.validateLinkedTransactionsNotLocked(
        [{ label: 'PAY-9', date: '2026-04-02' }],
        TransactionsLockingGroup.Sales,
        'this invoice',
      ),
    ).resolves.toBeUndefined();
  });

  it('allows the edit when locking is disabled or nothing is linked', async () => {
    const { guard, repo } = buildGuard({ isEnabled: false });

    await expect(
      guard.validateLinkedTransactionsNotLocked(
        [{ label: 'PAY-5', date: '2020-01-01' }],
        TransactionsLockingGroup.Sales,
        'this invoice',
      ),
    ).resolves.toBeUndefined();
    await expect(
      guard.validateLinkedTransactionsNotLocked(
        [],
        TransactionsLockingGroup.Sales,
        'this invoice',
      ),
    ).resolves.toBeUndefined();
    expect(repo.getTransactionsLockingType).toHaveBeenCalledTimes(1);
  });

  it('checks the module group when locking is per module', async () => {
    const { guard, repo } = buildGuard(
      lockedToMarch,
      TransactionsLockingGroup.Sales,
    );
    await expect(
      guard.validateLinkedTransactionsNotLocked(
        [{ label: 'Refund R-1', date: '2026-03-01' }],
        TransactionsLockingGroup.Purchases,
        'this vendor credit',
      ),
    ).rejects.toMatchObject({ errorType: LINKED_TRANSACTIONS_DATE_LOCKED });
    expect(repo.getTransactionsLocking).toHaveBeenCalledWith(
      TransactionsLockingGroup.Purchases,
    );
  });
});
