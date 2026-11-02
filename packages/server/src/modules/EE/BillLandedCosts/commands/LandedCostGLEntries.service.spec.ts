import { AccountNormal } from '@/modules/Accounts/Accounts.types';
import { LandedCostGLEntriesService } from './LandedCostGLEntries.service';

describe('LandedCostGLEntriesService', () => {
  let ledgerStorage: {
    commit: jest.Mock;
    deleteByReference: jest.Mock;
    tagUntaggedByReference: jest.Mock;
  };
  let billLandedCostModel: jest.Mock;
  let service: LandedCostGLEntriesService;

  const buildAllocatedLandedCost = (overrides: Record<string, any> = {}) =>
    ({
      id: 10,
      currencyCode: 'USD',
      exchangeRate: 2,
      costAccountId: 400,
      localAmount: 200,
      allocateEntries: [
        {
          entryId: 1,
          cost: 50,
          itemEntry: {
            itemId: 11,
            costAccountId: 500,
            item: { type: 'inventory', inventoryAccountId: 600 },
          },
        },
      ],
      ...overrides,
    }) as any;

  const bill = {
    billDate: '2023-01-01',
    billNumber: 'B-100',
    referenceNo: 'REF-1',
    branchId: 1,
    projectId: null,
  } as any;

  beforeEach(() => {
    ledgerStorage = {
      commit: jest.fn(),
      deleteByReference: jest.fn(),
      tagUntaggedByReference: jest.fn(),
    };
    billLandedCostModel = jest.fn();
    service = new LandedCostGLEntriesService(
      ledgerStorage as any,
      billLandedCostModel as any,
    );
  });

  describe('getLandedCostGLEntries', () => {
    it('builds a debit entry per allocate entry and a credit entry to the cost account', () => {
      const allocatedLandedCost = buildAllocatedLandedCost();

      const entries = service.getLandedCostGLEntries(allocatedLandedCost, bill);

      expect(entries).toHaveLength(2);

      expect(entries[0]).toMatchObject({
        debit: 100,
        accountId: 600,
        accountNormal: AccountNormal.DEBIT,
        indexGroup: 10,
        itemId: 11,
        transactionType: 'LandedCost',
        transactionId: 10,
      });
      expect(entries[1]).toMatchObject({
        credit: 200,
        accountId: 400,
        accountNormal: AccountNormal.CREDIT,
        indexGroup: 20,
        transactionType: 'LandedCost',
        transactionId: 10,
      });
    });

    it('uses the entry cost account for non-inventory items', () => {
      const allocatedLandedCost = buildAllocatedLandedCost({
        allocateEntries: [
          {
            entryId: 1,
            cost: 50,
            itemEntry: {
              itemId: 12,
              costAccountId: 700,
              item: { type: 'service' },
            },
          },
        ],
      });

      const entries = service.getLandedCostGLEntries(allocatedLandedCost, bill);

      expect(entries[0]).toMatchObject({ debit: 100, accountId: 700 });
    });

    it('throws an error when the account of an allocate entry cannot be determined', () => {
      const allocatedLandedCost = buildAllocatedLandedCost({
        allocateEntries: [{ entryId: 1, cost: 50, itemEntry: {} }],
      });

      expect(() =>
        service.getLandedCostGLEntries(allocatedLandedCost, bill),
      ).toThrow(/Cannot determine GL account/);
    });
  });

  describe('createLandedCostGLEntries', () => {
    it('commits the landed cost ledger of the given allocated landed cost', async () => {
      const allocatedLandedCost = buildAllocatedLandedCost({ bill });
      const lastWithGraphFetched = jest
        .fn()
        .mockResolvedValue(allocatedLandedCost);
      const firstWithGraphFetched = jest.fn(() => ({
        withGraphFetched: lastWithGraphFetched,
      }));
      const findById = jest.fn(() => ({
        withGraphFetched: firstWithGraphFetched,
      }));
      billLandedCostModel.mockReturnValue({
        query: jest.fn(() => ({ findById })),
      });
      const trx = { id: 'trx' };

      await service.createLandedCostGLEntries(10, trx as any);

      expect(ledgerStorage.commit).toHaveBeenCalledTimes(1);
      expect(ledgerStorage.commit.mock.calls[0][1]).toBe(trx);
    });

    it('throws an error when the landed cost bill is not found', async () => {
      const lastWithGraphFetched = jest.fn().mockResolvedValue(null);
      const firstWithGraphFetched = jest.fn(() => ({
        withGraphFetched: lastWithGraphFetched,
      }));
      const findById = jest.fn(() => ({
        withGraphFetched: firstWithGraphFetched,
      }));
      billLandedCostModel.mockReturnValue({
        query: jest.fn(() => ({ findById })),
      });

      await expect(service.createLandedCostGLEntries(10)).rejects.toThrow(
        /BillLandedCost or associated Bill not found/,
      );
    });
  });

  describe('revertLandedCostGLEntries', () => {
    it('deletes the ledger entries by the landed cost reference', async () => {
      const trx = { id: 'trx' };

      await service.revertLandedCostGLEntries(10, trx as any);

      expect(ledgerStorage.deleteByReference).toHaveBeenCalledWith(
        10,
        'LandedCost',
        trx,
      );
    });
  });

  /**
   * P7: landed cost from an unpaid bill counted on the cash basis straight
   * away. It is now an accrual like the bill, and on the cash basis it
   * follows the bill's payments.
   */
  describe('accounting basis', () => {
    it('a landed cost from a bill is an accrual', () => {
      const entries = service.getLandedCostGLEntries(
        buildAllocatedLandedCost({ fromTransactionType: 'Bill' }),
        bill,
      );
      entries.forEach((entry) => expect(entry.basis).toBe('accrual'));
    });

    it('a landed cost from an expense counts on both bases', () => {
      const entries = service.getLandedCostGLEntries(
        buildAllocatedLandedCost({ fromTransactionType: 'Expense' }),
        bill,
      );
      entries.forEach((entry) => expect(entry.basis).toBeUndefined());
    });
  });

  describe('getLandedCostCashGLEntries', () => {
    // 2 lines: 30.005 x 2 -> 60.01 and 19.99 x 2 -> 39.98 (local 99.99).
    const fromBill = () =>
      buildAllocatedLandedCost({
        fromTransactionType: 'Bill',
        exchangeRate: 2,
        costAccountId: 400,
        allocateEntries: [
          {
            entryId: 1,
            cost: 30.005,
            itemEntry: {
              itemId: 11,
              item: { type: 'inventory', inventoryAccountId: 600 },
            },
          },
          {
            entryId: 2,
            cost: 19.99,
            itemEntry: {
              itemId: 12,
              item: { type: 'inventory', inventoryAccountId: 601 },
            },
          },
        ],
      });
    const sum = (entries: any[], key: 'debit' | 'credit', accountId?: number) =>
      Math.round(
        entries
          .filter((e) => accountId === undefined || e.accountId === accountId)
          .reduce((acc, e) => acc + (e[key] || 0), 0) * 100,
      ) / 100;

    it('writes nothing while the bill is unpaid', () => {
      expect(
        service.getLandedCostCashGLEntries(fromBill(), bill, 1000, []),
      ).toEqual([]);
    });

    it('moves the paid share at each payment date and ends exactly at the accrual lines', () => {
      const entries = service.getLandedCostCashGLEntries(
        fromBill(),
        bill,
        1000,
        [
          { date: '2023-02-01', amount: 333.33 },
          { date: '2023-03-01', amount: 666.67 },
        ],
      );
      const first = entries.filter((e) => e.date === '2023-02-01');
      const second = entries.filter((e) => e.date === '2023-03-01');

      expect(sum(first, 'debit')).toBe(sum(first, 'credit'));
      expect(sum(second, 'debit')).toBe(sum(second, 'credit'));
      expect(sum(first, 'debit')).toBe(33.33);
      // Once fully paid each line ends at its accrual amount.
      expect(sum(entries, 'debit', 600)).toBe(60.01);
      expect(sum(entries, 'debit', 601)).toBe(39.98);
      expect(sum(entries, 'credit', 400)).toBe(99.99);
      entries.forEach((entry) => {
        expect(entry.basis).toBe('cash');
        expect(entry.transactionType).toBe('LandedCost');
      });
    });

    it('ignores what is paid beyond the bill total', () => {
      const entries = service.getLandedCostCashGLEntries(
        fromBill(),
        bill,
        1000,
        [
          { date: '2023-02-01', amount: 1000 },
          { date: '2023-03-01', amount: 50 },
        ],
      );
      expect(entries.every((e) => e.date === '2023-02-01')).toBe(true);
      expect(sum(entries, 'credit', 400)).toBe(99.99);
    });

    it('writes nothing for a landed cost from an expense (already paid)', () => {
      expect(
        service.getLandedCostCashGLEntries(
          buildAllocatedLandedCost({ fromTransactionType: 'Expense' }),
          bill,
          1000,
          [{ date: '2023-02-01', amount: 1000 }],
        ),
      ).toEqual([]);
    });
  });

  describe('rewriteLandedCostsCashGLEntriesOfSourceBills', () => {
    const queryOf = (landedCosts: any[]) => {
      const builder: any = {
        where: jest.fn(() => builder),
        whereIn: jest.fn(() => builder),
        withGraphFetched: jest.fn(() => builder),
        then: (resolve: any, reject: any) =>
          Promise.resolve(landedCosts).then(resolve, reject),
      };
      return { query: jest.fn(() => builder) };
    };

    /** A transaction answering the lock lookup's queries by table. */
    const fakeTrx = (tables: Record<string, any[]> = {}) => {
      const make = (table?: string) => {
        let name = table;
        const builder: any = {};
        ['where', 'whereIn', 'whereNull', 'select', 'join'].forEach(
          (method) => (builder[method] = jest.fn(() => builder)),
        );
        builder.from = jest.fn((from: string) => {
          name = from;
          return builder;
        });
        builder.then = (resolve: any, reject: any) =>
          Promise.resolve(tables[name] || []).then(resolve, reject);
        return builder;
      };
      const trx: any = jest.fn((table: string) => make(table.split(' ')[0]));
      trx.queryBuilder = () => make();
      return trx;
    };

    it('tags the untagged (old) entries accrual before rewriting the cash set', async () => {
      const landedCosts = [
        buildAllocatedLandedCost({ id: 10, fromTransactionType: 'Bill' }),
        buildAllocatedLandedCost({ id: 11, fromTransactionType: 'Bill' }),
      ];
      billLandedCostModel.mockReturnValue(queryOf(landedCosts));
      const trx = fakeTrx({
        accounts_transactions: [{ referenceId: 10, date: '2026-06-01' }],
      });
      const calls: string[] = [];
      ledgerStorage.tagUntaggedByReference.mockImplementation(async () => {
        calls.push('tag');
      });
      ledgerStorage.deleteByReference.mockImplementation(async () => {
        calls.push('delete');
      });

      await service.rewriteLandedCostsCashGLEntriesOfSourceBills([5], trx);

      expect(ledgerStorage.tagUntaggedByReference).toHaveBeenCalledWith(
        [10, 11],
        'LandedCost',
        'accrual',
        trx,
      );
      expect(ledgerStorage.deleteByReference).toHaveBeenCalledWith(
        10,
        'LandedCost',
        trx,
        { basis: 'cash' },
      );
      // Tagged first: an untagged row never sits next to a cash set.
      expect(calls).toEqual(['tag', 'delete', 'delete']);
    });

    it('leaves an old landed cost dated in a locked period as it is', async () => {
      const landedCosts = [
        buildAllocatedLandedCost({
          id: 10,
          fromTransactionType: 'Bill',
          fromTransactionId: 5,
        }),
        buildAllocatedLandedCost({
          id: 11,
          fromTransactionType: 'Bill',
          fromTransactionId: 5,
        }),
      ];
      billLandedCostModel.mockReturnValue(queryOf(landedCosts));
      const trx = fakeTrx({
        // #10 is old (untagged) and dated in the locked period; #11 is
        // already tagged.
        accounts_transactions: [{ referenceId: 10, date: '2026-03-15' }],
        bills_payments_entries: [{ billId: 5, date: '2026-04-10' }],
        settings: [
          { key: 'locking-type', value: 'all' },
          { key: 'all.active', value: 'true' },
          { key: 'all.lock_to_date', value: '2026-03-31' },
        ],
      });

      await service.rewriteLandedCostsCashGLEntriesOfSourceBills([5], trx);

      expect(ledgerStorage.tagUntaggedByReference).toHaveBeenCalledWith(
        [11],
        'LandedCost',
        'accrual',
        trx,
      );
      // No cash set next to #10's untagged rows.
      expect(ledgerStorage.deleteByReference).toHaveBeenCalledTimes(1);
      expect(ledgerStorage.deleteByReference.mock.calls[0][0]).toBe(11);
    });

    it('does nothing when no landed cost comes from the bills', async () => {
      billLandedCostModel.mockReturnValue(queryOf([]));

      await service.rewriteLandedCostsCashGLEntriesOfSourceBills([5]);

      expect(ledgerStorage.tagUntaggedByReference).not.toHaveBeenCalled();
      expect(ledgerStorage.deleteByReference).not.toHaveBeenCalled();
    });
  });
});
