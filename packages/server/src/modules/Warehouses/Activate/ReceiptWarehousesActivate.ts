import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { ItemEntry } from '@/modules/TransactionItemEntry/models/ItemEntry';
import { Warehouse } from '../models/Warehouse.model';
import { SaleReceipt } from '@/modules/SaleReceipts/models/SaleReceipt';

@Injectable()
export class ReceiptActivateWarehouses {
  constructor(
    @Inject(SaleReceipt.name)
    private readonly saleReceiptModel: TenantModelProxy<typeof SaleReceipt>,

    @Inject(ItemEntry.name)
    private readonly itemEntryModel: TenantModelProxy<typeof ItemEntry>,
  ) {}

  /**
   * Updates all sale receipts transactions with the primary warehouse.
   * @param {Warehouse} primaryWarehouse
   * @param   {Knex.Transaction} trx - The activation transaction.
   * @returns {Promise<void>}
   */
  public updateReceiptsWithWarehouse = async (
    primaryWarehouse: Warehouse,
    trx?: Knex.Transaction,
  ): Promise<void> => {
    // Updates the vendor credits transactions with primary warehouse.
    await this.saleReceiptModel().query(trx).update({
      warehouseId: primaryWarehouse.id,
    });
    // Update the sale invoices entries with primary warehouse.
    await this.itemEntryModel()
      .query(trx)
      .where('referenceType', 'SaleReceipt')
      .update({
        warehouseId: primaryWarehouse.id,
      });
  };
}
