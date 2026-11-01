import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
import { keyBy } from 'lodash';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { InventoryCostLotTracker } from '@/modules/InventoryCost/models/InventoryCostLotTracker';
import { LedgerStorageService } from '@/modules/Ledger/LedgerStorage.service';
import { Ledger } from '@/modules/Ledger/Ledger';
import { ILedgerEntry } from '@/modules/Ledger/types/Ledger.types';
import { TenancyContext } from '@/modules/Tenancy/TenancyContext.service';
import { getCostLotsGLEntries } from '@/modules/InventoryCost/InventoryCostLotsGL';
import { InventoryAdjustment } from '../../models/InventoryAdjustment';

/**
 * Writes the cost entries of the decrease adjustments (damaged, lost or
 * expired stock): the units leave at the item's average cost, worked out
 * by the cost lots like a sale.
 * -----
 * - Adjustment (loss) account -> Debit -> cost
 *    - Inventory -> Credit -> cost
 * -----
 * The entries are `costable`: the cost compute job rewrites them, so a
 * back-dated purchase re-works them. They are non-cash, so they count on
 * both bases (untagged), like the increase adjustments.
 */
@Injectable()
export class InventoryAdjustmentCostGLEntries {
  constructor(
    private readonly ledgerStorage: LedgerStorageService,
    private readonly tenancyContext: TenancyContext,

    @Inject(InventoryCostLotTracker.name)
    private readonly inventoryCostLotTracker: TenantModelProxy<
      typeof InventoryCostLotTracker
    >,

    @Inject(InventoryAdjustment.name)
    private readonly inventoryAdjustmentModel: TenantModelProxy<
      typeof InventoryAdjustment
    >,
  ) {}

  /**
   * Retrieves the cost GL entries of the given decrease adjustments lots.
   * Drafts and increases are skipped (an increase posts its own entries).
   * @param {InventoryCostLotTracker[]} lots - `OUT` lots with `item` fetched.
   * @param {Record<number, InventoryAdjustment>} adjustmentsById
   * @param {string} baseCurrency
   * @returns {ILedgerEntry[]}
   */
  public static getCostGLEntries(
    lots: InventoryCostLotTracker[],
    adjustmentsById: Record<number, InventoryAdjustment>,
    baseCurrency: string,
  ): ILedgerEntry[] {
    const costedLots = lots.filter((lot) => {
      const adjustment = adjustmentsById[lot.transactionId];
      return (
        lot.item && adjustment?.isPublished && adjustment.type === 'decrement'
      );
    });
    return getCostLotsGLEntries(costedLots, {
      commonEntry: (lot) => {
        const adjustment = adjustmentsById[lot.transactionId];

        return {
          currencyCode: baseCurrency,
          exchangeRate: 1,
          referenceNumber: adjustment.referenceNo,
          branchId: adjustment.branchId,
          userId: adjustment.userId,
          indexGroup: 20,
        };
      },
      debitAccountId: (lot) =>
        adjustmentsById[lot.transactionId].adjustmentAccountId,
      creditAccountId: (lot) => lot.item.inventoryAccountId,
    });
  }

  /**
   * Writes the decrease adjustments cost entries from the given date.
   * @param {Date} startingDate - Starting date.
   * @param {Knex.Transaction} trx
   */
  public writeInventoryCostJournalEntries = async (
    startingDate: Date,
    trx?: Knex.Transaction,
  ): Promise<void> => {
    const lots = await this.inventoryCostLotTracker()
      .query(trx)
      .where('direction', 'OUT')
      .where('transaction_type', 'InventoryAdjustment')
      .where('cost', '>', 0)
      .modify('filterDateRange', startingDate)
      .orderBy('date', 'ASC')
      .withGraphFetched('item');

    if (lots.length === 0) return;

    const adjustments = await this.inventoryAdjustmentModel()
      .query(trx)
      .whereIn(
        'id',
        lots.map((lot) => lot.transactionId),
      );
    const tenantMeta = await this.tenancyContext.getTenantMetadata();
    const entries = InventoryAdjustmentCostGLEntries.getCostGLEntries(
      lots,
      keyBy(adjustments, 'id'),
      tenantMeta.baseCurrency,
    );
    await this.ledgerStorage.commit(new Ledger(entries), trx);
  };
}
