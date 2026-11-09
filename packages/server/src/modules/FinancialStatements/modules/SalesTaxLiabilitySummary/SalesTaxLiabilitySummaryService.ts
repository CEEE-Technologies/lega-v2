import { SalesTaxLiabilitySummaryRepository } from './SalesTaxLiabilitySummaryRepository';
import { SalesTaxLiabilitySummary } from './SalesTaxLiabilitySummary';
import { SalesTaxLiabilitySummaryMeta } from './SalesTaxLiabilitySummaryMeta';
import { Injectable } from '@nestjs/common';
import { SalesTaxLiabilitySummaryQuery } from './SalesTaxLiability.types';
import { TenancyContext } from '@/modules/Tenancy/TenancyContext.service';
import { mergeSalesTaxLiabilityQueryWithDefaults } from './utils';
import { ModuleRef } from '@nestjs/core';

@Injectable()
export class SalesTaxLiabilitySummaryService {
  constructor(
    private readonly moduleRef: ModuleRef,
    private readonly salesTaxLiabilityMeta: SalesTaxLiabilitySummaryMeta,
    private readonly tenancyContext: TenancyContext,
  ) {}

  /**
   * Retrieve sales tax liability summary.
   * @param {SalesTaxLiabilitySummaryQuery} query
   * @returns
   */
  public async salesTaxLiability(query: SalesTaxLiabilitySummaryQuery) {
    const filter = mergeSalesTaxLiabilityQueryWithDefaults(query);

    // A new repository per report: it holds this report's query and
    // data, and one instance shared by every request (the service is
    // a singleton) let concurrent reports overwrite each other's.
    const repository = await this.moduleRef.resolve(
      SalesTaxLiabilitySummaryRepository,
      undefined,
      {
        strict: false,
      },
    );
    await repository.load(filter);

    // Retrieve the meta first to get date format.
    const meta = await this.salesTaxLiabilityMeta.meta(filter);

    // Get tenant metadata for baseCurrency
    const tenantMetadata = await this.tenancyContext.getTenantMetadata();

    const taxLiabilitySummary = new SalesTaxLiabilitySummary(
      filter,
      repository,
      {
        baseCurrency: tenantMetadata.baseCurrency,
        dateFormat: meta.dateFormat,
      },
    );

    return {
      data: taxLiabilitySummary.reportData(),
      query: filter,
      meta,
    };
  }
}
