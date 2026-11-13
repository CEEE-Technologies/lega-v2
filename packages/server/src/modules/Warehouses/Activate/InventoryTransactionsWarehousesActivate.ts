import { Knex } from 'knex';
import { InventoryTransaction } from '@/modules/InventoryCost/models/InventoryTransaction';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { Inject, Injectable } from '@nestjs/common';
import { Warehouse } from '../models/Warehouse.model';
import { InventoryCostLotTracker } from '@/modules/InventoryCost/models/InventoryCostLotTracker';

@Injectable()
export class InventoryActivateWarehouses {
  constructor(
    @Inject(InventoryTransaction.name)
    private readonly inventoryTransactionModel: TenantModelProxy<
      typeof InventoryTransaction
    >,

    @Inject(InventoryCostLotTracker.name)
    private readonly inventoryCostLotTrackerModel: TenantModelProxy<
      typeof InventoryCostLotTracker
    >,
  ) {}

  /**
   * Updates all inventory transactions with the primary warehouse.
   * @param   {number} tenantId
   * @param   {number} primaryWarehouse
   * @param   {Knex.Transaction} trx - The activation transaction.
   * @returns {Promise<void>}
   */
  public updateInventoryTransactionsWithWarehouse = async (
    primaryWarehouse: Warehouse,
    trx?: Knex.Transaction,
  ): Promise<void> => {
    // Updates the inventory transactions with primary warehouse.
    await this.inventoryTransactionModel().query(trx).update({
      warehouseId: primaryWarehouse.id,
    });
    await this.inventoryCostLotTrackerModel().query(trx).update({
      warehouseId: primaryWarehouse.id,
    });
  };
}
