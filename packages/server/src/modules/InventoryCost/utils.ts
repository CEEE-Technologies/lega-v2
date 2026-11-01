import { chain, isFinite, pick } from 'lodash';
import { roundMoney } from '@bigcapital/utils';
import { IItemEntryTransactionType } from '../TransactionItemEntry/ItemEntry.types';
import {
  TInventoryTransactionDirection,
  IInventoryTransaction,
  IInventoryTransactionItemEntry,
} from './types/InventoryCost.types';

/**
 * Grpups by transaction type and id the inventory transactions.
 * @param {IInventoryTransaction} invTransactions
 * @returns
 */
export function groupInventoryTransactionsByTypeId(
  transactions: { transactionType: string; transactionId: number }[],
): { transactionType: string; transactionId: number }[][] {
  return chain(transactions)
    .groupBy((t) => `${t.transactionType}-${t.transactionId}`)
    .values()
    .value();
}

/**
 * Transforms the items entries to inventory transactions.
 */
export function transformItemEntriesToInventory(transaction: {
  transactionId: number;
  transactionType: IItemEntryTransactionType;
  transactionNumber?: string;

  exchangeRate?: number;

  warehouseId?: number | null;

  date: Date | string;
  direction: TInventoryTransactionDirection;
  entries: IInventoryTransactionItemEntry[];
  createdAt: Date;
}): IInventoryTransaction[] {
  const exchangeRate = transaction.exchangeRate || 1;

  return transaction.entries.map((entry: IInventoryTransactionItemEntry) => ({
    ...pick(entry, ['itemId', 'quantity']),
    rate: getInventoryEntryRate(entry, transaction.direction, exchangeRate),
    transactionType: transaction.transactionType,
    transactionId: transaction.transactionId,
    direction: transaction.direction,
    date: transaction.date,
    entryId: entry.id,
    createdAt: transaction.createdAt,
    costAccountId: entry.costAccountId,

    warehouseId: entry.warehouseId || transaction.warehouseId,
    meta: {
      transactionNumber: transaction.transactionNumber,
      description: entry.description,
    },
  }));
}

/**
 * Retrieves the per-unit rate of the given item entry inventory transaction.
 *
 * Stock coming in is valued at what the books put into the inventory
 * account: the line total after its discount and excluding tax (so VAT
 * inside a tax-inclusive price isn't stock cost), converted to the base
 * currency and rounded to the cent like the ledger line. The raw unit price
 * included the VAT and ignored the discount.
 *
 * Stock going out keeps the entry price (its cost comes from the cost lots).
 * @param {IInventoryTransactionItemEntry} entry - Item entry.
 * @param {TInventoryTransactionDirection} direction - Direction.
 * @param {number} exchangeRate - Document exchange rate.
 * @returns {number}
 */
export function getInventoryEntryRate(
  entry: IInventoryTransactionItemEntry,
  direction: TInventoryTransactionDirection,
  exchangeRate: number,
): number {
  const quantity = Number(entry.quantity);
  const totalExcludingTax = entry.totalExcludingTax;

  if (direction === 'IN' && quantity > 0 && isFinite(totalExcludingTax)) {
    return roundMoney(totalExcludingTax * exchangeRate) / quantity;
  }
  return entry.rate * exchangeRate;
}
