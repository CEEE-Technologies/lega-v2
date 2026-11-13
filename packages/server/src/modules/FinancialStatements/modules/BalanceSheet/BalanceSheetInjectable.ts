import { IBalanceSheetDOO, IBalanceSheetQuery } from './BalanceSheet.types';
import { BalanceSheetRepository } from './BalanceSheetRepository';
import { BalanceSheetMetaInjectable } from './BalanceSheetMeta';
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { events } from '@/common/events/events';
import { BalanceSheet } from './BalanceSheet';
import { getBalanceSheetDefaultQuery } from './constants';
import { TenancyContext } from '@/modules/Tenancy/TenancyContext.service';
import { I18nService } from 'nestjs-i18n';
import { ModuleRef } from '@nestjs/core';

@Injectable()
export class BalanceSheetInjectable {
  constructor(
    private readonly balanceSheetMeta: BalanceSheetMetaInjectable,
    private readonly eventPublisher: EventEmitter2,
    private readonly tenancyContext: TenancyContext,
    private readonly i18n: I18nService,
    private readonly moduleRef: ModuleRef,
  ) {}

  /**
   * Retrieve balance sheet statement.
   * @param {IBalanceSheetQuery} query - Balance sheet query.
   * @return {Promise<IBalanceSheetStatement>}
   */
  public async balanceSheet(
    query: IBalanceSheetQuery,
  ): Promise<IBalanceSheetDOO> {
    const filter = {
      ...getBalanceSheetDefaultQuery(),
      ...query,
    };
    const tenantMetadata = await this.tenancyContext.getTenantMetadata();

    // Loads all resources.
    // A new repository per report: it holds this report's query and
    // data, and one instance shared by every request (the service is
    // a singleton) let concurrent reports overwrite each other's.
    const balanceSheetRepository = await this.moduleRef.resolve(
      BalanceSheetRepository,
      undefined,
      {
        strict: false,
      },
    );
    await balanceSheetRepository.asyncInitialize(filter);

    // Balance sheet meta first to get date format.
    const meta = await this.balanceSheetMeta.meta(filter);

    // Balance sheet report instance.
    const balanceSheetInstanace = new BalanceSheet(
      filter,
      balanceSheetRepository,
      this.i18n,
      {
        baseCurrency: tenantMetadata.baseCurrency,
        dateFormat: meta.dateFormat,
      },
    );
    // Balance sheet data.
    const data = balanceSheetInstanace.reportData();

    // Triggers `onBalanceSheetViewed` event.
    await this.eventPublisher.emitAsync(events.reports.onBalanceSheetViewed, {
      query,
    });
    return {
      query: filter,
      data,
      meta,
    };
  }
}
