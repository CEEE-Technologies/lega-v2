import { pick } from 'lodash';
import { InventoryTransaction } from '../models/InventoryTransaction';

export class InventoryAverageCostMethod {
  constructor() {}

  /**
   * Computes the cost of the given rate and quantity.
   * @param {number} rate - The given rate.
   * @param {number} quantity - The given quantity.
   * @returns {number}
   */
  private getCost(rate: number, quantity: number) {
    return quantity ? rate * quantity : rate;
  }

  /**
   * Key of a warehouse transfer line: its stock leaves one warehouse and
   * arrives in another under the same transfer and entry.
   */
  private transferKey(invTransaction: InventoryTransaction) {
    return `${invTransaction.transactionId}-${invTransaction.entryId}`;
  }

  /**
   * Tracks the cost of the given item inventory transactions with the
   * average cost method and retrieves the cost lots.
   *
   * Stock coming in is valued at its rate, except:
   * - a customer return (credit note) comes back at the average cost at its
   *   date: the credit note isn't linked to the invoice line it reverses, so
   *   the original cost isn't known. The selling price is not a cost.
   * - a warehouse transfer arrives at the cost its stock left the other
   *   warehouse at, so moving stock never changes its value. The cost stored
   *   on the transfer is for display only.
   *
   * @param {InventoryTransaction[]} invTransactions - Ordered by date, `IN`
   *   before `OUT` on the same date.
   * @param {number} openingQuantity - Quantity before the first transaction.
   * @param {number} openingCost - Cost before the first transaction.
   * @param {number} fallbackAverageCost - The last known average cost, used
   *   while no stock is left (e.g. a return after everything was sold).
   */
  public trackingCostTransactions(
    invTransactions: InventoryTransaction[],
    openingQuantity: number = 0,
    openingCost: number = 0,
    fallbackAverageCost: number = 0,
  ) {
    const costTransactions: any[] = [];

    // Cumulative item quantity and cost. This will decrement after
    // each out transactions depends on its quantity and cost.
    let accQuantity: number = openingQuantity;
    let accCost: number = openingCost;

    // The last average cost while there was stock.
    let lastAverageCost =
      openingQuantity > 0 ? openingCost / openingQuantity : fallbackAverageCost;

    const currentAverageCost = () =>
      accQuantity > 0 ? accCost / accQuantity : lastAverageCost;

    const rememberAverageCost = () => {
      if (accQuantity > 0) {
        lastAverageCost = accCost / accQuantity;
      }
    };

    // Transfer lines whose stock leaves later in the list: their arrival is
    // tracked right after it, at the same cost.
    const pendingTransferOuts = new Set(
      invTransactions
        .filter(
          (t) =>
            t.transactionType === 'WarehouseTransfer' && t.direction === 'OUT',
        )
        .map((t) => this.transferKey(t)),
    );
    const deferredTransferIns: Record<string, InventoryTransaction[]> = {};
    const transferOutUnitCosts: Record<string, number> = {};

    const commonEntryOf = (invTransaction: InventoryTransaction) => ({
      invTransId: invTransaction.id,
      ...pick(invTransaction, [
        'date',
        'direction',
        'itemId',
        'quantity',
        'rate',
        'entryId',
        'transactionId',
        'transactionType',
        'createdAt',
        'costAccountId',
        'branchId',
        'warehouseId',
      ]),
      inventoryTransactionId: invTransaction.id,
    });

    const trackIn = (
      invTransaction: InventoryTransaction,
      unitCost?: number,
    ) => {
      const commonEntry = commonEntryOf(invTransaction);
      const rate = unitCost ?? invTransaction.rate;
      const inCost = this.getCost(rate, invTransaction.quantity);

      // Increases the quantity and cost in `IN` inventory transactions.
      accQuantity += invTransaction.quantity;
      accCost += inCost;

      costTransactions.push({
        ...commonEntry,
        ...(unitCost !== undefined ? { rate: unitCost } : {}),
        cost: inCost,
      });
      rememberAverageCost();
    };

    const trackOut = (invTransaction: InventoryTransaction) => {
      const commonEntry = commonEntryOf(invTransaction);

      // Average cost = Total cost / Total quantity
      const averageCost = accQuantity ? accCost / accQuantity : 0;

      const quantity =
        accQuantity > 0
          ? Math.min(invTransaction.quantity, accQuantity)
          : invTransaction.quantity;

      // Cost = the transaction quantity * Average cost.
      const cost = this.getCost(averageCost, quantity);

      costTransactions.push({
        ...commonEntry,
        quantity,
        cost,
      });
      accQuantity = Math.max(accQuantity - quantity, 0);
      accCost = Math.max(accCost - cost, 0);

      if (invTransaction.quantity > quantity) {
        const remainingQuantity = Math.max(
          invTransaction.quantity - quantity,
          0,
        );
        const remainingIncome = remainingQuantity * invTransaction.rate;

        costTransactions.push({
          ...commonEntry,
          quantity: remainingQuantity,
          cost: 0,
        });
        accQuantity = Math.max(accQuantity - remainingQuantity, 0);
        accCost = Math.max(accCost - remainingIncome, 0);
      }
      // The whole cost that left (the part beyond the stock left is 0).
      return cost;
    };

    invTransactions.forEach((invTransaction: InventoryTransaction) => {
      const isTransfer = invTransaction.transactionType === 'WarehouseTransfer';

      switch (invTransaction.direction) {
        case 'IN': {
          if (isTransfer) {
            const key = this.transferKey(invTransaction);

            if (transferOutUnitCosts[key] !== undefined) {
              trackIn(invTransaction, transferOutUnitCosts[key]);
            } else if (pendingTransferOuts.has(key)) {
              (deferredTransferIns[key] = deferredTransferIns[key] || []).push(
                invTransaction,
              );
            } else {
              trackIn(invTransaction, currentAverageCost());
            }
          } else if (invTransaction.transactionType === 'CreditNote') {
            trackIn(invTransaction, currentAverageCost());
          } else {
            trackIn(invTransaction);
          }
          break;
        }
        case 'OUT': {
          const outCost = trackOut(invTransaction);

          if (isTransfer) {
            // The arriving stock carries exactly the cost that left.
            const outUnitCost = invTransaction.quantity
              ? outCost / invTransaction.quantity
              : 0;
            const key = this.transferKey(invTransaction);
            transferOutUnitCosts[key] = outUnitCost;
            pendingTransferOuts.delete(key);

            (deferredTransferIns[key] || []).forEach((transferIn) =>
              trackIn(transferIn, outUnitCost),
            );
            delete deferredTransferIns[key];
          }
          break;
        }
      }
    });
    return costTransactions;
  }
}
