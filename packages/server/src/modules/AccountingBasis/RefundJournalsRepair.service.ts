import * as moment from 'moment';
import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
import { roundMoney, subtractMoney } from '@bigcapital/utils';
import { TENANCY_DB_CONNECTION } from '@/modules/Tenancy/TenancyDB/TenancyDB.constants';
import { UnitOfWork } from '@/modules/Tenancy/TenancyDB/UnitOfWork.service';
import { runDryRun } from '@/modules/Tenancy/TenancyDB/DryRun';
import { TenancyContext } from '@/modules/Tenancy/TenancyContext.service';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { AccountTransaction } from '@/modules/Accounts/models/AccountTransaction.model';
import { Ledger } from '@/modules/Ledger/Ledger';
import { AccountingBasis } from '@/common/types/AccountingBasis';
import { RefundCreditNote } from '@/modules/CreditNoteRefunds/models/RefundCreditNote';
import { RefundCreditNoteGLEntries } from '@/modules/CreditNoteRefunds/commands/RefundCreditNoteGLEntries';
import { RefundVendorCredit } from '@/modules/VendorCreditsRefund/models/RefundVendorCredit';
import { RefundVendorCreditGLEntries } from '@/modules/VendorCreditsRefund/commands/RefundVendorCreditGLEntries';
import { getLockedPeriodChecker } from './MoneyHealthCheck';

export type RefundJournalType = 'RefundCreditNote' | 'RefundVendorCredit';

interface IRefundRecord {
  referenceType: RefundJournalType;
  referenceId: number;
  /** The refund reference number, for the report. */
  number: string | null;
  date: string;
  currencyCode: string;
  exchangeRate: number;
  amount: number;
}

/**
 * A foreign currency refund whose stored journal differs from the one the
 * app writes for it today.
 */
export interface IRefundJournal extends IRefundRecord {
  /** In a locked period: listed, never rewritten. */
  locked: boolean;
  /** Per basis and account: what is stored and what it should be (net debit). */
  differences: Array<{
    basis: 'accrual' | 'cash';
    accountId: number;
    stored: number;
    expected: number;
  }>;
}

export interface IRefundJournalsRepairResult {
  repaired: IRefundJournal[];
  skipped: IRefundJournal[];
  failed: Array<IRefundJournal & { error: string }>;
}

type IRow = {
  accountId?: number;
  debit?: number;
  credit?: number;
  basis?: string | null;
};

/** A row with no basis is in both; refunds tag every row, so read it as accrual. */
const basisOf = (row: IRow): 'accrual' | 'cash' =>
  row.basis === AccountingBasis.Cash ? 'cash' : 'accrual';

/** Net debit of the rows, by basis and account. */
const netByBasisAndAccount = (rows: IRow[]): Map<string, number> => {
  const net = new Map<string, number>();
  rows.forEach((row) => {
    const key = `${basisOf(row)}:${row.accountId}`;
    const amount = subtractMoney(
      roundMoney(Number(row.debit) || 0),
      roundMoney(Number(row.credit) || 0),
    );
    net.set(key, roundMoney((net.get(key) || 0) + amount));
  });
  return net;
};

/**
 * Finds and rewrites the journals of foreign currency refunds (credit note
 * refunds and vendor credit refunds) posted before the fix that converts
 * them to the base currency:
 * - the A/R (A/P) and bank lines were the refund amount unconverted
 *   (EUR 65.18 at 1.23 posted as USD 65.18, not 80.17), on the accrual
 *   and the cash basis;
 * - a credit note refund debited the base currency A/R, not the A/R of its
 *   currency that the credit note credited;
 * - a vendor credit refund's cash basis lines were converted at the vendor
 *   credit's rate, not the refund's.
 *
 * Only refunds in a currency other than the base currency (or at a rate
 * other than 1) are looked at: a base currency refund didn't change. A
 * foreign refund stored at the rate 1 is left out too (most likely sent
 * without a rate, which used to default to 1): its stored rate is probably
 * wrong, so rewriting from it isn't a fix. Those are listed apart, to check
 * by hand (`foreignRefundsAtRateOne`). A refund is listed when its stored journal differs, on any account of
 * either basis, from the journal the app builds for it today; rewriting it
 * uses the same code as saving the refund. Refunds in a locked period are
 * listed and skipped. Run only on request: `tenants:repair-refund-journals`
 * (a dry run unless `--apply` is given).
 */
@Injectable()
export class RefundJournalsRepairService {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly tenancyContext: TenancyContext,
    private readonly refundCreditNoteGLEntries: RefundCreditNoteGLEntries,
    private readonly refundVendorCreditGLEntries: RefundVendorCreditGLEntries,

    @Inject(TENANCY_DB_CONNECTION)
    private readonly tenantKnex: () => Knex,

    @Inject(RefundCreditNote.name)
    private readonly refundCreditNoteModel: TenantModelProxy<
      typeof RefundCreditNote
    >,

    @Inject(RefundVendorCredit.name)
    private readonly refundVendorCreditModel: TenantModelProxy<
      typeof RefundVendorCredit
    >,

    @Inject(AccountTransaction.name)
    private readonly accountTransactionModel: TenantModelProxy<
      typeof AccountTransaction
    >,
  ) {}

  /**
   * Lists the refunds whose journal is off. Changes nothing: the journals
   * are built in a transaction that is always rolled back (building one may
   * look up, or create, an account such as the A/R of a currency).
   * @returns {Promise<IRefundJournal[]>}
   */
  public async scan(): Promise<IRefundJournal[]> {
    const knex = this.tenantKnex();
    const isLocked = await getLockedPeriodChecker(knex);

    return runDryRun(knex, async (trx) => {
      const found: Omit<IRefundJournal, 'locked'>[] = [];

      const refunds = (await this.foreignRefunds(trx)).filter(
        (refund) => !refund.atRateOne,
      );
      for (const { atRateOne: _atRateOne, ...refund } of refunds) {
        const ledger = await this.buildLedger(refund, trx);
        const stored = await this.accountTransactionModel().query(trx).where({
          referenceType: refund.referenceType,
          referenceId: refund.referenceId,
        });
        const differences = this.compare(stored, ledger?.getEntries() || []);

        if (differences.length > 0) {
          found.push({ ...refund, differences });
        }
      }
      return found.map((item) => ({
        ...item,
        locked: isLocked(item.date, item.referenceType),
      }));
    });
  }

  /**
   * Lists the refunds in a foreign currency stored at the rate 1: most
   * likely sent without a rate (it used to default to 1). Their journal is
   * right for the stored rate, so nothing here changes them; the rate
   * itself needs checking by hand (delete the refund and enter it again
   * with its rate). The scan leaves them out.
   * @returns {Promise<IRefundRecord[]>}
   */
  public async foreignRefundsAtRateOne(): Promise<IRefundRecord[]> {
    return (await this.foreignRefunds())
      .filter((refund) => refund.atRateOne)
      .map(({ atRateOne: _atRateOne, ...refund }) => refund);
  }

  /**
   * Rewrites the listed journals, each in its own transaction, skipping the
   * ones in a locked period.
   * @returns {Promise<IRefundJournalsRepairResult>}
   */
  public async repair(): Promise<IRefundJournalsRepairResult> {
    const result: IRefundJournalsRepairResult = {
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

  private async getBaseCurrency(): Promise<string | undefined> {
    return (await this.tenancyContext.getTenantMetadata())?.baseCurrency;
  }

  /**
   * The refunds not in the base currency, or at a rate other than 1;
   * `atRateOne`: not in the base currency, yet at the rate 1.
   */
  private async foreignRefunds(
    trx?: Knex.Transaction,
  ): Promise<Array<IRefundRecord & { atRateOne: boolean }>> {
    const baseCurrency = await this.getBaseCurrency();
    const isForeign = (refund: {
      currencyCode: string;
      exchangeRate: number;
    }) =>
      (!!refund.currencyCode && refund.currencyCode !== baseCurrency) ||
      Number(refund.exchangeRate || 1) !== 1;

    const creditRefunds = await this.refundCreditNoteModel()
      .query(trx)
      .orderBy('id');
    const vendorRefunds = await this.refundVendorCreditModel()
      .query(trx)
      .orderBy('id');

    const record = (
      referenceType: RefundJournalType,
      refund: RefundCreditNote | RefundVendorCredit,
    ): IRefundRecord & { atRateOne: boolean } => ({
      referenceType,
      referenceId: refund.id,
      number: refund.referenceNo || null,
      date: moment(refund.date).format('YYYY-MM-DD'),
      currencyCode: refund.currencyCode,
      exchangeRate: Number(refund.exchangeRate),
      amount: Number(refund.amount),
      atRateOne:
        !!refund.currencyCode &&
        refund.currencyCode !== baseCurrency &&
        Number(refund.exchangeRate || 1) === 1,
    });
    return [
      ...creditRefunds
        .filter(isForeign)
        .map((refund) => record('RefundCreditNote', refund)),
      ...vendorRefunds
        .filter(isForeign)
        .map((refund) => record('RefundVendorCredit', refund)),
    ];
  }

  /** The journal the app writes today for the refund (both bases). */
  private buildLedger(
    refund: IRefundRecord,
    trx: Knex.Transaction,
  ): Promise<Ledger | null> {
    return refund.referenceType === 'RefundCreditNote'
      ? this.refundCreditNoteGLEntries.buildRefundCreditGLedger(
          refund.referenceId,
          trx,
        )
      : this.refundVendorCreditGLEntries.buildRefundVendorCreditGLedger(
          refund.referenceId,
          trx,
        );
  }

  /** Rewrites the journal of the given refund. */
  private rewrite(item: IRefundJournal, trx: Knex.Transaction): Promise<void> {
    return item.referenceType === 'RefundCreditNote'
      ? this.refundCreditNoteGLEntries.rewriteRefundCreditGLEntries(
          item.referenceId,
          trx,
        )
      : this.refundVendorCreditGLEntries.rewriteRefundVendorCreditGLEntries(
          item.referenceId,
          trx,
        );
  }

  /**
   * Compares the stored rows with the entries the app builds today, per
   * basis and account (net debit, to the cent).
   */
  private compare(
    stored: IRow[],
    expected: IRow[],
  ): IRefundJournal['differences'] {
    const storedNet = netByBasisAndAccount(stored);
    const expectedNet = netByBasisAndAccount(expected);
    const keys = new Set([...storedNet.keys(), ...expectedNet.keys()]);

    return [...keys]
      .map((key) => {
        const [basis, accountId] = key.split(':');
        return {
          basis: basis as 'accrual' | 'cash',
          accountId: Number(accountId),
          stored: storedNet.get(key) || 0,
          expected: expectedNet.get(key) || 0,
        };
      })
      .filter((row) => row.stored !== row.expected)
      .sort((a, b) =>
        a.basis === b.basis
          ? a.accountId - b.accountId
          : a.basis < b.basis
            ? -1
            : 1,
      );
  }
}
