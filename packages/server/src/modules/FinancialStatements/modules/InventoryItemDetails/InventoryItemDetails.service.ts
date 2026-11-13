import { I18nService } from 'nestjs-i18n';
import { Injectable } from '@nestjs/common';
import {
  IInventoryDetailsQuery,
  IInvetoryItemDetailDOO,
} from './InventoryItemDetails.types';
import { InventoryDetails } from './InventoryItemDetails';
import { InventoryItemDetailsRepository } from './InventoryItemDetailsRepository';
import { InventoryDetailsMetaInjectable } from './InventoryItemDetailsMeta';
import { getInventoryItemDetailsDefaultQuery } from './constant';
import { TenancyContext } from '@/modules/Tenancy/TenancyContext.service';
import { ModuleRef } from '@nestjs/core';

@Injectable()
export class InventoryDetailsService {
  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly inventoryDetailsMeta: InventoryDetailsMetaInjectable,
    private readonly i18n: I18nService,
    private readonly tenancyContext: TenancyContext,
  ) {}

  /**
   * Retrieve the inventory details report data.
   * @param {IInventoryDetailsQuery} query - Inventory details query.
   * @return {Promise<IInvetoryItemDetailDOO>}
   */
  public async inventoryDetails(
    query: IInventoryDetailsQuery,
  ): Promise<IInvetoryItemDetailDOO> {
    const filter = {
      ...getInventoryItemDetailsDefaultQuery(),
      ...query,
    };

    // Initialize the inventory item details repository.
    // A new repository per report: it holds this report's query and
    // data, and one instance shared by every request (the service is
    // a singleton) let concurrent reports overwrite each other's.
    const inventoryItemDetailsRepository = await this.moduleRef.resolve(
      InventoryItemDetailsRepository,
      undefined,
      {
        strict: false,
      },
    );
    inventoryItemDetailsRepository.setFilter(filter);
    await inventoryItemDetailsRepository.asyncInit();

    // Retrieve the meta first to get date format.
    const meta = await this.inventoryDetailsMeta.meta(query);

    // Inventory details report mapper.
    const inventoryDetailsInstance = new InventoryDetails(
      filter,
      inventoryItemDetailsRepository,
      this.i18n,
      { baseCurrency: meta.baseCurrency, dateFormat: meta.dateFormat },
    );

    return {
      data: inventoryDetailsInstance.reportData(),
      query: filter,
      meta,
    };
  }
}
