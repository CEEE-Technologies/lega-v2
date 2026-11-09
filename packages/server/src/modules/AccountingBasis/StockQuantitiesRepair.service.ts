import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { UnitOfWork } from '@/modules/Tenancy/TenancyDB/UnitOfWork.service';
import {
  getStockTotalDifferences,
  IDataHealthStockTotal,
} from './DataHealthCheck';

export interface IStockQuantitiesScan {
  /** Whether the per-warehouse quantities were checked (multi-warehouse on). */
  warehousesChecked: boolean;
  differences: IDataHealthStockTotal[];
}

/**
 * Sets the stored stock on hand from the stock movements, per item and
 * (when multi-warehouse is on) per item and warehouse: the figures health
 * check H3 (b) lists as different.
 *
 * Stored quantities are only ever added to or subtracted from, so one that
 * went wrong stayed wrong. The round-3 migration that merged duplicate
 * warehouse rows (`20261107130000`) added them together, and with the old
 * bug both rows had received every change, so the merged figure could be
 * double. Run only on request: `tenants:repair-stock-quantities`.
 */
@Injectable()
export class StockQuantitiesRepairService {
  constructor(
    private readonly uow: UnitOfWork,

    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
  ) {}

  /** Lists the differences (health check H3 (b)). Changes nothing. */
  public scan(): Promise<IStockQuantitiesScan> {
    return getStockTotalDifferences(this.tenantKnex());
  }

  /**
   * Sets every listed quantity from the movements, in one transaction.
   *
   * The stored quantities are locked first and the movements summed after
   * that (READ COMMITTED): a document saved meanwhile either committed
   * before the lock (its movements are counted) or waits for the lock and
   * then adds its own change on top of the repaired figure. A save that
   * already holds one item's row and then needs another the repair holds
   * is a deadlock: the database undoes one of the two (no wrong figure is
   * written), so run this when nobody is saving stock documents.
   */
  public repair(): Promise<IStockQuantitiesScan> {
    return this.uow.withTransaction(async (trx) => {
      await trx
        .queryBuilder()
        .from('items')
        .where('type', 'inventory')
        .select('id')
        .forUpdate();
      await trx
        .queryBuilder()
        .from('items_warehouses_quantity')
        .select('item_id')
        .forUpdate();

      const scan = await getStockTotalDifferences(trx);
      for (const difference of scan.differences) {
        if (difference.level === 'item') {
          await trx
            .queryBuilder()
            .from('items')
            .where('id', difference.itemId)
            .update({ quantity_on_hand: difference.fromMovements });
        } else {
          await this.setWarehouseQuantity(trx, difference);
        }
      }
      return scan;
    });
  }

  /** Sets the item's quantity in the warehouse (adds the row if missing). */
  private async setWarehouseQuantity(
    trx: Knex.Transaction,
    difference: IDataHealthStockTotal,
  ) {
    const updated = await trx
      .queryBuilder()
      .from('items_warehouses_quantity')
      .where({
        item_id: difference.itemId,
        warehouse_id: difference.warehouseId,
      })
      .update({ quantity_on_hand: difference.fromMovements });
    if (updated > 0) return;

    await trx
      .queryBuilder()
      .insert({
        item_id: difference.itemId,
        warehouse_id: difference.warehouseId,
        quantity_on_hand: difference.fromMovements,
      })
      .into('items_warehouses_quantity');
  }
}
