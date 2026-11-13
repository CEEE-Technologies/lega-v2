import { Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { Knex } from 'knex';
import * as moment from 'moment';
import '@/utils/moment-mysql';
import { AuditLog } from './models/AuditLog.model';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { runAfterTransaction } from '@/modules/Tenancy/TenancyDB/TransactionsHooks';

const METADATA_JSON_MAX = 8000;

export interface RecordAuditLogParams {
  /**
   * The save's transaction. The row is written only after it commits, and
   * never if it is undone. The row is not written with the transaction.
   */
  trx?: Knex.Transaction;
  action: string;
  subject: string;
  subjectId?: number | null;
  metadata?: Record<string, unknown> | null;
}

@Injectable()
export class AuditLogService {
  constructor(
    private readonly cls: ClsService,
    @Inject(AuditLog.name)
    private readonly auditLogModel: TenantModelProxy<typeof AuditLog>,
    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
  ) {}

  /**
   * Records one audit row once the save's transaction (`trx`) has committed;
   * without `trx` it is written straight away.
   *
   * The row is never written with the save's transaction: if that insert hit
   * a deadlock, the database would undo the whole save while the save carried
   * on without a transaction, and its ledger and stock rows would be kept
   * for a document that no longer exists. Writing after the commit also
   * means an undone save logs nothing.
   *
   * The user, IP and company connection are read now, while the request's
   * context is still there. A failed insert is logged and never fails the
   * save.
   */
  async record(params: RecordAuditLogParams): Promise<void> {
    const row = {
      userId: this.cls.get<number>('userId') ?? null,
      action: params.action,
      subject: params.subject,
      subjectId: this.normalizeSubjectId(params.subjectId),
      metadata: this.normalizeMetadata(params.metadata),
      ip: (this.cls.get<string>('ip') as string) ?? null,
      // MySQL DATETIME expects `YYYY-MM-DD HH:mm:ss`, not ISO-8601 with `T`/`Z`.
      createdAt: moment().toMySqlDateTime(),
    };
    const model = this.auditLogModel();
    const knex = this.tenantKnex();
    const insert = () => model.query(knex).insert(row);

    if (!params.trx) {
      await insert();
      return;
    }
    runAfterTransaction(params.trx, insert);
  }

  /**
   * Normalizes the audit subject id into an integer or null. Controllers pass
   * ids as strings when `ParseIntPipe` is not applied, which would otherwise
   * fail the model `integer` validation.
   */
  private normalizeSubjectId(
    subjectId: number | string | null | undefined,
  ): number | null {
    if (subjectId == null || subjectId === '') return null;

    const value = Number(subjectId);
    return Number.isInteger(value) ? value : null;
  }

  private normalizeMetadata(
    metadata: Record<string, unknown> | null | undefined,
  ): Record<string, unknown> | null {
    if (metadata == null) return null;
    try {
      const s = JSON.stringify(metadata);
      if (s.length <= METADATA_JSON_MAX) return metadata;
      return {
        _truncated: true,
        summary: s.slice(0, METADATA_JSON_MAX),
      };
    } catch {
      return { _error: 'metadata_not_serializable' };
    }
  }
}
