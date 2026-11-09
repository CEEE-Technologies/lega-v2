import { EventEmitter2 } from '@nestjs/event-emitter';
import { Injectable } from '@nestjs/common';
import {
  IVendorBalanceSummaryQuery,
  IVendorBalanceSummaryStatement,
} from './VendorBalanceSummary.types';
import { VendorBalanceSummaryReport } from './VendorBalanceSummary';
import { VendorBalanceSummaryRepository } from './VendorBalanceSummaryRepository';
import { VendorBalanceSummaryMeta } from './VendorBalanceSummaryMeta';
import { getVendorBalanceSummaryDefaultQuery } from './utils';
import { events } from '@/common/events/events';
import { ModuleRef } from '@nestjs/core';

@Injectable()
export class VendorBalanceSummaryService {
  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly vendorBalanceSummaryMeta: VendorBalanceSummaryMeta,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Retrieve the statment of customer balance summary report.
   * @param {IVendorBalanceSummaryQuery} query -
   * @return {Promise<IVendorBalanceSummaryStatement>}
   */
  public async vendorBalanceSummary(
    query: IVendorBalanceSummaryQuery,
  ): Promise<IVendorBalanceSummaryStatement> {
    const filter = { ...getVendorBalanceSummaryDefaultQuery(), ...query };

    // A new repository per report: it holds this report's query and
    // data, and one instance shared by every request (the service is
    // a singleton) let concurrent reports overwrite each other's.
    const vendorBalanceSummaryRepository = await this.moduleRef.resolve(
      VendorBalanceSummaryRepository,
      undefined,
      {
        strict: false,
      },
    );
    vendorBalanceSummaryRepository.setFilter(filter);
    await vendorBalanceSummaryRepository.asyncInit();

    // Retrieve the vendor balance summary meta first to get date format.
    const meta = await this.vendorBalanceSummaryMeta.meta(filter);

    // Report instance.
    const reportInstance = new VendorBalanceSummaryReport(
      vendorBalanceSummaryRepository,
      filter,
      { baseCurrency: meta.baseCurrency, dateFormat: meta.dateFormat },
    );

    // Triggers `onVendorBalanceSummaryViewed` event.
    await this.eventEmitter.emitAsync(
      events.reports.onVendorBalanceSummaryViewed,
      { query },
    );
    return {
      data: reportInstance.reportData(),
      query: filter,
      meta,
    };
  }
}
