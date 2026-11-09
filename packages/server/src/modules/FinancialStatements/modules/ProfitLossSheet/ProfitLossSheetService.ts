import {
  IProfitLossSheetQuery,
  IProfitLossSheetMeta,
  IProfitLossSheetNode,
} from './ProfitLossSheet.types';
import ProfitLossSheet from './ProfitLossSheet';
import { mergeQueryWithDefaults } from './utils';
import { ProfitLossSheetRepository } from './ProfitLossSheetRepository';
import { ProfitLossSheetMeta } from './ProfitLossSheetMeta';
import { events } from '@/common/events/events';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Injectable } from '@nestjs/common';
import { I18nService } from 'nestjs-i18n';
import { ModuleRef } from '@nestjs/core';

@Injectable()
export class ProfitLossSheetService {
  constructor(
    private readonly profitLossSheetMeta: ProfitLossSheetMeta,
    private readonly eventPublisher: EventEmitter2,
    private readonly i18nService: I18nService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Retrieve profit/loss sheet statement.
   * @param {IProfitLossSheetQuery} query
   * @return { }
   */
  public profitLossSheet = async (
    query: IProfitLossSheetQuery,
  ): Promise<{
    data: IProfitLossSheetNode[];
    query: IProfitLossSheetQuery;
    meta: IProfitLossSheetMeta;
  }> => {
    // Merges the given query with default filter query.
    const filter = mergeQueryWithDefaults(query);

    // Loads the profit/loss sheet data.
    // A new repository per report: it holds this report's query and
    // data, and one instance shared by every request (the service is
    // a singleton) let concurrent reports overwrite each other's.
    const profitLossRepository = await this.moduleRef.resolve(
      ProfitLossSheetRepository,
      undefined,
      {
        strict: false,
      },
    );
    profitLossRepository.setFilter(filter);
    await profitLossRepository.asyncInitialize();

    // Retrieve the profit/loss sheet meta first to get date format.
    const meta = await this.profitLossSheetMeta.meta(filter);

    // Profit/Loss report instance.
    const profitLossInstance = new ProfitLossSheet(
      profitLossRepository,
      filter,
      this.i18nService,
      { baseCurrency: meta.baseCurrency, dateFormat: meta.dateFormat },
    );
    // Profit/loss report data and columns.
    const data = profitLossInstance.reportData();

    // Triggers `onProfitLossSheetViewed` event.
    await this.eventPublisher.emitAsync(
      events.reports.onProfitLossSheetViewed,
      { query },
    );

    return {
      query: filter,
      data,
      meta,
    };
  };
}
