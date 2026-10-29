import { Inject, Injectable, Logger } from '@nestjs/common';
import { Knex } from 'knex';
import { uniq } from 'lodash';
import { toCents } from '@bigcapital/utils';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { LedgerStorageService } from '@/modules/Ledger/LedgerStorage.service';
import { AccountRepository } from '@/modules/Accounts/repositories/Account.repository';
import { TenancyContext } from '@/modules/Tenancy/TenancyContext.service';
import { Ledger } from '@/modules/Ledger/Ledger';
import { ILedgerEntry } from '@/modules/Ledger/types/Ledger.types';
import { AccountNormal } from '@/interfaces/Account';
import { AccountingBasis } from '@/common/types/AccountingBasis';
import { NO_FOREIGN_AMOUNT } from '@/utils/ledger-rounding';
import { getLockedPeriodChecker } from './MoneyHealthCheck';
import {
  getCreditApplicationAdjustment,
  getCreditApplicationRows,
  ICreditApplicationKind,
  ICreditApplicationRow,
} from './CreditApplications';

import {
  CREDIT_NOTE_APPLICATIONS,
  VENDOR_CREDIT_APPLICATIONS,
} from './CreditApplications';

export { CREDIT_NOTE_APPLICATIONS, VENDOR_CREDIT_APPLICATIONS };

/**
 * Posts and rebuilds the exchange lines of the credits applied to invoices
 * and bills (see CreditApplications.ts).
 */
@Injectable()
export class CreditApplicationsGLService {
  private readonly logger = new Logger(CreditApplicationsGLService.name);

  constructor(
    private readonly ledgerStorage: LedgerStorageService,
    private readonly accountRepository: AccountRepository,
    private readonly tenancyContext: TenancyContext,

    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,
  ) {}

  /**
   * The ledger lines of one application (none when the rates and the
   * rounding agree).
   */
  private async getApplicationEntries(
    kind: ICreditApplicationKind,
    row: ICreditApplicationRow,
    baseCurrency: string,
    trx?: Knex.Transaction,
  ): Promise<ILedgerEntry[]> {
    const { adjustment } = getCreditApplicationAdjustment(row);
    if (toCents(adjustment) === 0) return [];

    const arapAccount = kind.receivable
      ? await this.accountRepository.findOrCreateAccountReceivable(
          row.currencyCode,
          {},
          trx,
        )
      : await this.accountRepository.findOrCreateAccountsPayable(
          row.currencyCode,
          {},
          trx,
        );
    const exchangeAccount = (await this.accountRepository.findBySlug(
      'exchange-grain-loss',
    )) as unknown as { id: number };
    const amount = Math.abs(adjustment);
    // Receivable: the credit relieved more than the invoice needs -> debit
    // A/R back (gain). Payable: mirror (credit A/P back).
    const arapDebit = kind.receivable ? adjustment > 0 : adjustment < 0;
    const common = {
      currencyCode: baseCurrency,
      exchangeRate: 1,
      ...NO_FOREIGN_AMOUNT,
      transactionType: kind.referenceType,
      transactionId: row.id,
      transactionNumber: row.creditNumber,
      date: row.date,
      branchId: row.branchId,
      indexGroup: 60,
      basis: AccountingBasis.Accrual,
    };
    return [
      {
        ...common,
        debit: arapDebit ? amount : 0,
        credit: arapDebit ? 0 : amount,
        accountId: arapAccount.id,
        contactId: row.contactId,
        accountNormal: kind.receivable
          ? AccountNormal.DEBIT
          : AccountNormal.CREDIT,
        index: 1,
      },
      {
        ...common,
        debit: arapDebit ? 0 : amount,
        credit: arapDebit ? amount : 0,
        accountId: exchangeAccount.id,
        accountNormal: AccountNormal.DEBIT,
        index: 2,
      },
    ];
  }

  /**
   * Rebuilds the ledger sets of the applications of the given documents
   * and credits, in id order, and removes the sets of deleted
   * applications. Sets in a locked period are left as they are (logged; the
   * money health check shows any difference).
   * @param {ICreditApplicationKind} kind
   * @param {{ documentIds?: number[]; creditIds?: number[]; removedIds?: number[] }} scope
   * @param {Knex.Transaction} trx
   */
  public async rebuild(
    kind: ICreditApplicationKind,
    scope: {
      documentIds?: number[];
      creditIds?: number[];
      removedIds?: number[];
    },
    trx?: Knex.Transaction,
  ): Promise<void> {
    const knex = trx ?? this.tenantKnex();

    for (const id of uniq((scope.removedIds || []).filter(Boolean))) {
      await this.ledgerStorage.deleteByReference(id, kind.referenceType, trx);
    }
    const rows = await getCreditApplicationRows(knex, kind, {
      documentIds: (scope.documentIds || []).filter(Boolean),
      creditIds: (scope.creditIds || []).filter(Boolean),
    });
    await this.rebuildRows(kind, rows, trx);
  }

  /**
   * Rebuilds every application set of the tenant (the money repair) and
   * removes the sets of applications that no longer exist.
   * @returns {Promise<{ rebuilt: number; orphansRemoved: number; skipped: number }>}
   */
  public async rebuildAll(): Promise<{
    rebuilt: number;
    orphansRemoved: number;
    skipped: number;
  }> {
    const knex = this.tenantKnex();
    const result = { rebuilt: 0, orphansRemoved: 0, skipped: 0 };

    for (const kind of [CREDIT_NOTE_APPLICATIONS, VENDOR_CREDIT_APPLICATIONS]) {
      await knex.transaction(async (trx) => {
        const rows = await getCreditApplicationRows(trx, kind, 'all');
        const skipped = await this.rebuildRows(kind, rows, trx);
        result.rebuilt += rows.length - skipped;
        result.skipped += skipped;

        const orphans: { referenceId: number }[] = await trx(
          'accounts_transactions',
        )
          .distinct('reference_id as referenceId')
          .where('reference_type', kind.referenceType)
          .whereNotIn('reference_id', trx(kind.applicationsTable).select('id'));
        for (const { referenceId } of orphans) {
          await this.ledgerStorage.deleteByReference(
            referenceId,
            kind.referenceType,
            trx,
          );
          result.orphansRemoved += 1;
        }
      });
    }
    return result;
  }

  /**
   * Rebuilds the sets of the given applications, in id order, skipping
   * those in a locked period.
   * @returns {Promise<number>} The number skipped.
   */
  private async rebuildRows(
    kind: ICreditApplicationKind,
    rows: ICreditApplicationRow[],
    trx?: Knex.Transaction,
  ): Promise<number> {
    if (rows.length === 0) return 0;
    const knex = trx ?? this.tenantKnex();
    const tenant = await this.tenancyContext.getTenant(true);
    const baseCurrency = tenant?.metadata?.baseCurrency;
    const isLocked = await getLockedPeriodChecker(knex as Knex);
    const skipped: ICreditApplicationRow[] = [];

    for (const row of rows) {
      if (isLocked(row.date, kind.referenceType)) {
        skipped.push(row);
        continue;
      }
      await this.ledgerStorage.deleteByReference(
        row.id,
        kind.referenceType,
        trx,
      );
      const entries = await this.getApplicationEntries(
        kind,
        row,
        baseCurrency,
        trx,
      );
      if (entries.length > 0) {
        await this.ledgerStorage.commit(new Ledger(entries), trx);
      }
    }
    if (skipped.length > 0) {
      this.logger.warn(
        `The exchange lines of ${kind.referenceType} ${skipped
          .map((row) => `#${row.id} (${row.date})`)
          .join(', ')} are in a locked period and were not rebuilt; ` +
          'the money health check shows any cent left behind.',
      );
    }
    return skipped.length;
  }
}
