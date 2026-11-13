import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { events } from '@/common/events/events';
import {
  IInventoryValuationReportQuery,
  IInventoryValuationSheet,
} from './InventoryValuationSheet.types';
import { InventoryValuationMetaInjectable } from './InventoryValuationSheetMeta';
import { getInventoryValuationDefaultQuery } from './_constants';
import { InventoryValuationSheetRepository } from './InventoryValuationSheetRepository';
import { InventoryValuationSheet } from './InventoryValuationSheet';
import { ModuleRef } from '@nestjs/core';

@Injectable()
export class InventoryValuationSheetService {
  constructor(
    private readonly inventoryValuationMeta: InventoryValuationMetaInjectable,
    private readonly eventPublisher: EventEmitter2,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Inventory valuation sheet.
   * @param {IInventoryValuationReportQuery} query - Valuation query.
   */
  public async inventoryValuationSheet(
    query: IInventoryValuationReportQuery,
  ): Promise<IInventoryValuationSheet> {
    const filter = {
      ...getInventoryValuationDefaultQuery(),
      ...query,
    };
    // A new repository per report: it holds this report's query and
    // data, and one instance shared by every request (the service is
    // a singleton) let concurrent reports overwrite each other's.
    const inventoryValuationSheetRepository = await this.moduleRef.resolve(
      InventoryValuationSheetRepository,
      undefined,
      {
        strict: false,
      },
    );
    inventoryValuationSheetRepository.setFilter(filter);
    await inventoryValuationSheetRepository.asyncInit();

    // Retrieves the inventorty valuation meta first to get date format.
    const meta = await this.inventoryValuationMeta.meta(filter);

    const inventoryValuationInstance = new InventoryValuationSheet(
      filter,
      inventoryValuationSheetRepository,
      { baseCurrency: meta.baseCurrency, dateFormat: meta.dateFormat },
    );
    // Retrieve the inventory valuation report data.
    const inventoryValuationData = inventoryValuationInstance.reportData();

    // Triggers `onInventoryValuationViewed` event.
    await this.eventPublisher.emitAsync(
      events.reports.onInventoryValuationViewed,
      { query },
    );

    return {
      data: inventoryValuationData,
      query: filter,
      meta,
    };
  }
}
