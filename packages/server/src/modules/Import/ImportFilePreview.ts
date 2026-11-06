import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
import { ImportFilePreviewPOJO } from './interfaces';
import { ImportFileProcess } from './ImportFileProcess';
import { ImportAls } from './ImportALS';
import { TENANCY_DB_CONNECTION } from '../Tenancy/TenancyDB/TenancyDB.constants';
import { runDryRun } from '../Tenancy/TenancyDB/DryRun';

@Injectable()
export class ImportFilePreview {
  constructor(
    private readonly importFile: ImportFileProcess,
    private readonly importAls: ImportAls,

    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
  ) {}

  /**
   * Preview the imported file results before commiting the transactions.
   * @param {string} importId -
   * @returns {Promise<ImportFilePreviewPOJO>}
   */
  public async preview(importId: string): Promise<ImportFilePreviewPOJO> {
    return this.importAls.runPreview<Promise<ImportFilePreviewPOJO>>(() =>
      this.previewAlsRun(importId),
    );
  }

  /**
   * Preview the imported file results before commiting the transactions.
   * @param {number} importId
   * @returns {Promise<ImportFilePreviewPOJO>}
   */
  public async previewAlsRun(importId: string): Promise<ImportFilePreviewPOJO> {
    // The preview runs the real import in a transaction that is always
    // rolled back, also when the import fails, so it keeps nothing, runs no
    // after-save work and always gives its connection back.
    return runDryRun(this.tenantKnex(), (trx) =>
      this.importFile.import(importId, trx),
    );
  }
}
