import { Inject, Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { TenantModelProxy } from '../System/models/TenantBaseModel';
import { InventoryTransaction } from '../InventoryCost/models/InventoryTransaction';

@Injectable()
export class UpdateInventoryTransactionsWithWarehouse {
  constructor(
    @Inject(InventoryTransaction.name)
    private readonly inventoryTransactionModel: TenantModelProxy<
      typeof InventoryTransaction
    >,
  ) {}

  /**
   * Updates all inventory transactions with primary warehouse.
   * @param {number} warehouseId - Warehouse ID.
   * @param {Knex.Transaction} trx - The activation transaction.
   */
  public run = async (primaryWarehouseId: number, trx?: Knex.Transaction) => {
    await this.inventoryTransactionModel().query(trx).update({
      warehouseId: primaryWarehouseId,
    });
  };
}
