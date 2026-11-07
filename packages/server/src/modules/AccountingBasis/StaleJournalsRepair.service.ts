import * as moment from 'moment';
import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
import { roundMoney, subtractMoney } from '@bigcapital/utils';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { UnitOfWork } from '@/modules/Tenancy/TenancyDB/UnitOfWork.service';
import { runDryRun } from '@/modules/Tenancy/TenancyDB/DryRun';
import { TenancyContext } from '@/modules/Tenancy/TenancyContext.service';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { AccountRepository } from '@/modules/Accounts/repositories/Account.repository';
import { AccountTransaction } from '@/modules/Accounts/models/AccountTransaction.model';
import { LedgerStorageService } from '@/modules/Ledger/LedgerStorage.service';
import { Ledger } from '@/modules/Ledger/Ledger';
import { ILedgerEntry } from '@/modules/Ledger/types/Ledger.types';
import { AccountingBasis } from '@/common/types/AccountingBasis';
import { CreditNote } from '@/modules/CreditNotes/models/CreditNote';
import { CreditNoteAccrualGL } from '@/modules/CreditNotes/commands/CreditNoteAccrualGL';
import { PaymentReceived } from '@/modules/PaymentReceived/models/PaymentReceived';
import { PaymentReceivedGLEntries } from '@/modules/PaymentReceived/commands/PaymentReceivedGLEntries';
import { BillPayment } from '@/modules/BillPayments/models/BillPayment';
import { BillPaymentGLEntries } from '@/modules/BillPayments/commands/BillPaymentGLEntries';
import { PaymentEntryTypes } from '@/modules/Contacts/ContactOpeningBalance.constants';
import { getLockedPeriodChecker } from './MoneyHealthCheck';

export type StaleJournalType = 'CreditNote' | 'PaymentReceive' | 'BillPayment';

/**
 * A record whose stored journal differs from the one the app writes for it
 * today.
 */
export interface IStaleJournal {
  referenceType: StaleJournalType;
  referenceId: number;
  /** The document number, for the report. */
  number: string | null;
  date: string;
  /** In a locked period: listed, never rewritten. */
  locked: boolean;
  /** Per account: what is stored and what it should be (net debit). */
  differences: Array<{ accountId: number; stored: number; expected: number }>;
}

export interface IStaleJournalsRepairResult {
  repaired: IStaleJournal[];
  skipped: IStaleJournal[];
  failed: Array<IStaleJournal & { error: string }>;
}

/**
 * The cost-of-sales rows of a credit note (returned stock) share its
 * reference; they are written by the cost job, not by the credit note
 * journal, so they are left alone here.
 */
const CREDIT_NOTE_COST_INDEX_GROUP = 20;

/** Net debit of the rows, by account, in cents. */
const netByAccount = (
  rows: Array<{ accountId?: number; debit?: number; credit?: number }>,
): Map<number, number> => {
  const net = new Map<number, number>();
  rows.forEach((row) => {
    const amount = subtractMoney(
      roundMoney(Number(row.debit) || 0),
      roundMoney(Number(row.credit) || 0),
    );
    net.set(row.accountId, roundMoney((net.get(row.accountId) || 0) + amount));
  });
  return net;
};

/**
 * Finds and rewrites the journals left behind by bugs fixed in PRs 14 and
 * 17, which only correct a record when it is saved again (Q12):
 * - credit notes edited before PR 14 kept the journal of their first
 *   version;
 * - foreign opening-balance payments (received and made) saved before
 *   PR 17 relieved A/R or A/P at the payment rate, with no exchange
 *   gain/loss line.
 *
 * A record is listed when its stored accrual journal differs, on any
 * account, from the journal the app builds for it today. Rewriting uses
 * the same code as saving the record again. Records in a locked period are
 * listed and skipped. Run only on request: `tenants:repair-stale-journals`
 * (a dry run unless `--apply` is given).
 */
@Injectable()
export class StaleJournalsRepairService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly tenancyContext: TenancyContext,
    private readonly accountRepository: AccountRepository,
    private readonly ledgerStorage: LedgerStorageService,
    private readonly paymentReceivedGLEntries: PaymentReceivedGLEntries,
    private readonly billPaymentGLEntries: BillPaymentGLEntries,

    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,

    @Inject(CreditNote.name)
    private readonly creditNoteModel: TenantModelProxy<typeof CreditNote>,

    @Inject(PaymentReceived.name)
    private readonly paymentReceivedModel: TenantModelProxy<
      typeof PaymentReceived
    >,

    @Inject(BillPayment.name)
    private readonly billPaymentModel: TenantModelProxy<typeof BillPayment>,

    @Inject(AccountTransaction.name)
    private readonly accountTransactionModel: TenantModelProxy<
      typeof AccountTransaction
    >,
  ) {}

  /**
   * Lists the stale journals. Changes nothing: the journals are built in a
   * transaction that is always rolled back (building one may look up, or
   * create, an account such as the A/R of a currency).
   * @returns {Promise<IStaleJournal[]>}
   */
  public async scan(): Promise<IStaleJournal[]> {
    const knex = this.tenantKnex();
    const isLocked = await getLockedPeriodChecker(knex);

    return runDryRun(knex, async (trx) => {
      const found = [
        ...(await this.scanCreditNotes(trx)),
        ...(await this.scanPaymentsReceived(trx)),
        ...(await this.scanBillPayments(trx)),
      ];
      return found.map((item) => ({
        ...item,
        locked: isLocked(item.date, item.referenceType),
      }));
    });
  }

  /**
   * Rewrites the stale journals, each in its own transaction, skipping the
   * ones in a locked period.
   * @returns {Promise<IStaleJournalsRepairResult>}
   */
  public async repair(): Promise<IStaleJournalsRepairResult> {
    const result: IStaleJournalsRepairResult = {
      repaired: [],
      skipped: [],
      failed: [],
    };
    for (const item of await this.scan()) {
      if (item.locked) {
        result.skipped.push(item);
        continue;
      }
      try {
        await this.uow.withTransaction((trx) => this.rewrite(item, trx));
        result.repaired.push(item);
      } catch (error) {
        result.failed.push({ ...item, error: error?.message ?? `${error}` });
      }
    }
    return result;
  }

  /**
   * Rewrites the journal of the given record.
   */
  private async rewrite(
    item: IStaleJournal,
    trx: Knex.Transaction,
  ): Promise<void> {
    switch (item.referenceType) {
      case 'CreditNote':
        return this.rewriteCreditNote(item.referenceId, trx);
      case 'PaymentReceive':
        return this.paymentReceivedGLEntries.rewritePaymentGLEntries(
          item.referenceId,
          trx,
        );
      case 'BillPayment':
        return this.billPaymentGLEntries.rewritePaymentGLEntries(
          item.referenceId,
          trx,
        );
    }
  }

  // ---------------------------------------------------------------------
  // Credit notes.
  // ---------------------------------------------------------------------

  /**
   * Builds the journal the app writes today for the credit note (the
   * same builder as `CreditNoteGLEntries`).
   */
  private async getCreditNoteLedger(
    creditNote: CreditNote,
    trx: Knex.Transaction,
  ): Promise<Ledger> {
    const ARAccount =
      await this.accountRepository.findOrCreateAccountReceivable(
        creditNote.currencyCode,
        {},
        trx,
      );
    const discountAccount =
      await this.accountRepository.findOrCreateDiscountAccount({}, trx);
    const adjustmentAccount =
      await this.accountRepository.findOrCreateOtherChargesAccount({}, trx);

    return new CreditNoteAccrualGL(creditNote)
      .setARAccountId(ARAccount.id)
      .setDiscountAccountId(discountAccount.id)
      .setAdjustmentAccountId(adjustmentAccount.id)
      .getCreditNoteLedger();
  }

  /** The stored rows of the credit note journal (not its cost rows). */
  private creditNoteRows(creditNoteId: number, trx: Knex.Transaction) {
    return this.accountTransactionModel()
      .query(trx)
      .where({ referenceType: 'CreditNote', referenceId: creditNoteId })
      .where((q) =>
        q
          .whereNull('indexGroup')
          .orWhereNot('indexGroup', CREDIT_NOTE_COST_INDEX_GROUP),
      );
  }

  private async scanCreditNotes(
    trx: Knex.Transaction,
  ): Promise<Omit<IStaleJournal, 'locked'>[]> {
    const creditNotes = await this.creditNoteModel()
      .query(trx)
      .whereNotNull('openedAt')
      .withGraphFetched('entries.item');
    const found: Omit<IStaleJournal, 'locked'>[] = [];

    for (const creditNote of creditNotes) {
      const ledger = await this.getCreditNoteLedger(creditNote, trx);
      const stored = await this.creditNoteRows(creditNote.id, trx);
      const differences = this.compare(stored, ledger.getEntries());

      if (differences.length > 0) {
        found.push({
          referenceType: 'CreditNote',
          referenceId: creditNote.id,
          number: creditNote.creditNoteNumber || null,
          date: moment(creditNote.creditNoteDate).format('YYYY-MM-DD'),
          differences,
        });
      }
    }
    return found;
  }

  /**
   * Rewrites the credit note journal, keeping its cost rows (written by
   * the cost job). An edit rewrites both, and the cost job then writes the
   * cost rows again; here only the journal was wrong.
   */
  private async rewriteCreditNote(
    creditNoteId: number,
    trx: Knex.Transaction,
  ): Promise<void> {
    const creditNote = await this.creditNoteModel()
      .query(trx)
      .findById(creditNoteId)
      .withGraphFetched('entries.item');

    const stored = await this.creditNoteRows(
      creditNoteId,
      trx,
    ).withGraphFetched('account');
    await this.ledgerStorage.delete(
      Ledger.fromTransactions(stored).reverse(),
      trx,
    );
    if (!creditNote?.isPublished) return;

    await this.ledgerStorage.commit(
      await this.getCreditNoteLedger(creditNote, trx),
      trx,
    );
  }

  // ---------------------------------------------------------------------
  // Opening balance payments.
  // ---------------------------------------------------------------------

  /** The accrual rows stored for the payment. */
  private accrualRows(
    referenceType: StaleJournalType,
    referenceId: number,
    trx: Knex.Transaction,
  ) {
    return this.accountTransactionModel()
      .query(trx)
      .where({ referenceType, referenceId })
      .where((q) =>
        q.whereNull('basis').orWhere('basis', AccountingBasis.Accrual),
      );
  }

  /** The accrual entries of a ledger (a payment ledger has both bases). */
  private accrualEntries(ledger: Ledger): ILedgerEntry[] {
    return ledger
      .getEntries()
      .filter(
        (entry) => !entry.basis || entry.basis === AccountingBasis.Accrual,
      );
  }

  private async scanPaymentsReceived(
    trx: Knex.Transaction,
  ): Promise<Omit<IStaleJournal, 'locked'>[]> {
    const baseCurrency = (await this.tenancyContext.getTenantMetadata())
      ?.baseCurrency;
    const payments = await this.paymentReceivedModel()
      .query(trx)
      .whereExists(
        this.paymentReceivedModel()
          .relatedQuery('entries', trx)
          .where('entryType', PaymentEntryTypes.OpeningBalance),
      )
      .withGraphFetched('entries.invoice.entries');
    const found: Omit<IStaleJournal, 'locked'>[] = [];

    for (const payment of payments) {
      const ledger =
        await this.paymentReceivedGLEntries.getPaymentReceiveGLedger(
          payment,
          baseCurrency,
          trx,
        );
      const stored = await this.accrualRows('PaymentReceive', payment.id, trx);
      const differences = this.compare(stored, this.accrualEntries(ledger));

      if (differences.length > 0) {
        found.push({
          referenceType: 'PaymentReceive',
          referenceId: payment.id,
          number: payment.paymentReceiveNo || null,
          date: moment(payment.paymentDate).format('YYYY-MM-DD'),
          differences,
        });
      }
    }
    return found;
  }

  private async scanBillPayments(
    trx: Knex.Transaction,
  ): Promise<Omit<IStaleJournal, 'locked'>[]> {
    const baseCurrency = (await this.tenancyContext.getTenantMetadata())
      ?.baseCurrency;
    const payments = await this.billPaymentModel()
      .query(trx)
      .whereExists(
        this.billPaymentModel()
          .relatedQuery('entries', trx)
          .where('entryType', PaymentEntryTypes.OpeningBalance),
      )
      .withGraphFetched('entries.bill.entries.item');
    const found: Omit<IStaleJournal, 'locked'>[] = [];

    for (const payment of payments) {
      const ledger = await this.billPaymentGLEntries.getBillPaymentGLedger(
        payment,
        baseCurrency,
        trx,
      );
      const stored = await this.accrualRows('BillPayment', payment.id, trx);
      const differences = this.compare(stored, this.accrualEntries(ledger));

      if (differences.length > 0) {
        found.push({
          referenceType: 'BillPayment',
          referenceId: payment.id,
          number: payment.paymentNumber || null,
          date: moment(payment.paymentDate).format('YYYY-MM-DD'),
          differences,
        });
      }
    }
    return found;
  }

  // ---------------------------------------------------------------------

  /**
   * Compares the stored rows with the entries the app builds today, per
   * account (net debit, to the cent).
   */
  private compare(
    stored: Array<{ accountId?: number; debit?: number; credit?: number }>,
    expected: ILedgerEntry[],
  ): IStaleJournal['differences'] {
    const storedNet = netByAccount(stored);
    const expectedNet = netByAccount(expected);
    const accounts = new Set([...storedNet.keys(), ...expectedNet.keys()]);

    return [...accounts]
      .map((accountId) => ({
        accountId,
        stored: storedNet.get(accountId) || 0,
        expected: expectedNet.get(accountId) || 0,
      }))
      .filter((row) => row.stored !== row.expected);
  }
}
