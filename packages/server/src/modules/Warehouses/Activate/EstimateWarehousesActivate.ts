import { Knex } from 'knex';
import { ItemEntry } from '@/modules/TransactionItemEntry/models/ItemEntry';
import { SaleEstimate } from '@/modules/SaleEstimates/models/SaleEstimate';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { Inject, Injectable } from '@nestjs/common';
import { Warehouse } from '../models/Warehouse.model';

@Injectable()
export class EstimatesActivateWarehouses {
  constructor(
    @Inject(SaleEstimate.name)
    private readonly saleEstimateModel: TenantModelProxy<typeof SaleEstimate>,

    @Inject(ItemEntry.name)
    private readonly itemEntryModel: TenantModelProxy<typeof ItemEntry>,
  ) {}

  /**
   * Updates all inventory transactions with the primary warehouse.
   * @param {Warehouse} primaryWarehouse
   * @param   {Knex.Transaction} trx - The activation transaction.
   * @returns {Promise<void>}
   */
  public updateEstimatesWithWarehouse = async (
    primaryWarehouse: Warehouse,
    trx?: Knex.Transaction,
  ): Promise<void> => {
    // Updates the sale estimates with primary warehouse.
    await this.saleEstimateModel()
      .query(trx)
      .update({ warehouseId: primaryWarehouse.id });

    // Update the sale estimates entries with primary warehouse.
    await this.itemEntryModel()
      .query(trx)
      .where('referenceType', 'SaleEstimate')
      .update({
        warehouseId: primaryWarehouse.id,
      });
  };
}
