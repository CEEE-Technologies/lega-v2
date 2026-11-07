import { Knex } from 'knex';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { VendorCredit } from '@/modules/VendorCredit/models/VendorCredit';
import { ItemEntry } from '@/modules/TransactionItemEntry/models/ItemEntry';
import { Warehouse } from '../models/Warehouse.model';
import { Inject, Injectable } from '@nestjs/common';

@Injectable()
export class VendorCreditActivateWarehouses {
  constructor(
    @Inject(VendorCredit.name)
    private readonly vendorCreditModel: TenantModelProxy<typeof VendorCredit>,

    @Inject(ItemEntry.name)
    private readonly itemEntryModel: TenantModelProxy<typeof ItemEntry>,
  ) {}

  /**
   * Updates all vendor credits transactions with the primary warehouse.
   * @param   {Warehouse} primaryWarehouse
   * @param   {Knex.Transaction} trx - The activation transaction.
   * @returns {Promise<void>}
   */
  public updateCreditsWithWarehouse = async (
    primaryWarehouse: Warehouse,
    trx?: Knex.Transaction,
  ): Promise<void> => {
    // Updates the vendor credits transactions with primary warehouse.
    await this.vendorCreditModel().query(trx).update({
      warehouseId: primaryWarehouse.id,
    });

    // Update the sale invoices entries with primary warehouse.
    await this.itemEntryModel()
      .query(trx)
      .where('referenceType', 'VendorCredit')
      .update({
        warehouseId: primaryWarehouse.id,
      });
  };
}
