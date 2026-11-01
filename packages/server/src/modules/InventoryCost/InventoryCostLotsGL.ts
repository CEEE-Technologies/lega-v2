import { AccountNormal } from '@/interfaces/Account';
import { ILedgerEntry } from '../Ledger/types/Ledger.types';
import { InventoryCostLotTracker } from './models/InventoryCostLotTracker';
import { groupInventoryTransactionsByTypeId } from './utils';
import { increment } from '@/utils/increment';

export interface ICostLotGLOptions {
  /** Fields shared by both legs of the lot (date, reference, basis...). */
  commonEntry: (lot: InventoryCostLotTracker) => Partial<ILedgerEntry>;
  /** The account debited with the lot cost. */
  debitAccountId: (lot: InventoryCostLotTracker) => number;
  /** The account credited with the lot cost. */
  creditAccountId: (lot: InventoryCostLotTracker) => number;
}

/**
 * Builds the ledger entries that move the cost of the given cost lots from
 * one account to another, two legs per lot, like the invoices cost of sales
 * entries. The entries are `costable`: the cost compute job deletes and
 * rewrites them from its starting date, so a back-dated purchase re-works
 * them.
 * @param {InventoryCostLotTracker[]} lots - Cost lots with `item` fetched.
 * @param {ICostLotGLOptions} options
 * @returns {ILedgerEntry[]}
 */
export const getCostLotsGLEntries = (
  lots: InventoryCostLotTracker[],
  options: ICostLotGLOptions,
): ILedgerEntry[] => {
  const groups = groupInventoryTransactionsByTypeId(
    lots,
  ) as InventoryCostLotTracker[][];

  return groups
    .map((groupLots) => {
      const getIndex = increment(0);

      return groupLots
        .filter((lot) => lot.cost > 0)
        .map((lot) => {
          const common = {
            debit: 0,
            credit: 0,
            date: lot.date,
            transactionType: lot.transactionType,
            transactionId: lot.transactionId,
            createdAt: lot.createdAt,
            itemId: lot.itemId,
            ...options.commonEntry(lot),
            costable: true,
          };
          return [
            {
              ...common,
              debit: lot.cost,
              accountId: options.debitAccountId(lot),
              accountNormal: AccountNormal.DEBIT,
              index: getIndex(),
            },
            {
              ...common,
              credit: lot.cost,
              accountId: options.creditAccountId(lot),
              accountNormal: AccountNormal.DEBIT,
              index: getIndex(),
            },
          ] as ILedgerEntry[];
        })
        .flat();
    })
    .flat();
};
