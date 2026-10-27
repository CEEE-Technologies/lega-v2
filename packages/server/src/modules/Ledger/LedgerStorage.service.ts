import { Knex } from 'knex';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ILedger } from './types/Ledger.types';
import { LedgerContactsBalanceStorage } from './LedgerContactStorage.service';
import { LedegrAccountsStorage } from './LedgetAccountStorage.service';
import { LedgerEntriesStorageService } from './LedgerEntriesStorage.service';
import { AccountTransaction } from '../Accounts/models/AccountTransaction.model';
import { Ledger } from './Ledger';
import { TenantModelProxy } from '../System/models/TenantBaseModel';
import { LedgerClickHouseSink } from '../Analytics/services/LedgerClickHouseSink.service';
import { AccountingBasis } from '@/common/types/AccountingBasis';
import { Account } from '../Accounts/models/Account.model';
import {
  formatUnbalancedGroup,
  isLedgerStrictMode,
  normalizeLedgerEntries,
  recordLedgerStrictViolation,
} from './LedgerNormalizer';

@Injectable()
export class LedgerStorageService {
  private readonly logger = new Logger(LedgerStorageService.name);

  /**
   * @param {LedgerContactsBalanceStorage} ledgerContactsBalance - Ledger contacts balance storage.
   * @param {LedegrAccountsStorage} ledgerAccountsBalance - Ledger accounts balance storage.
   * @param {LedgerEntriesStorageService} ledgerEntriesService - Ledger entries storage service.
   */
  constructor(
    private ledgerContactsBalance: LedgerContactsBalanceStorage,
    private ledgerAccountsBalance: LedegrAccountsStorage,
    private ledgerEntriesService: LedgerEntriesStorageService,

    @Inject(AccountTransaction.name)
    private accountTransactionModel: TenantModelProxy<
      typeof AccountTransaction
    >,

    private ledgerClickHouseSink: LedgerClickHouseSink,

    @Inject(Account.name)
    private accountModel: TenantModelProxy<typeof Account>,
  ) {}

  /**
   * Rounds every entry to cents and balances each transaction set (per
   * basis) to the cent, putting a rounding leftover on the largest
   * income/expense line. A set off by more than rounding is logged, or
   * throws in the strict ledger mode (tests).
   * Stored entries (reversals) pass through unchanged.
   * @param {ILedger} ledger
   * @param {Knex.Transaction} trx
   * @returns {Promise<ILedger>}
   */
  public normalize = async (
    ledger: ILedger,
    trx?: Knex.Transaction,
  ): Promise<ILedger> => {
    const entries = ledger.getEntries();

    if (entries.length === 0 || entries.every((entry) => entry.entryId)) {
      return ledger;
    }
    const accountsIds = [
      ...new Set(entries.map((entry) => entry.accountId).filter(Boolean)),
    ];
    const accounts =
      accountsIds.length > 0
        ? await this.accountModel()
            .query(trx)
            .whereIn('id', accountsIds)
            .select('id', 'accountType')
        : [];
    const accountTypes = new Map(
      accounts.map((account) => [account.id, account.accountType]),
    );
    const { entries: normalized, unbalanced } = normalizeLedgerEntries(
      entries,
      accountTypes,
    );
    if (unbalanced.length > 0) {
      const message = `Unbalanced ledger entries: ${unbalanced
        .map(formatUnbalancedGroup)
        .join('; ')}`;

      if (isLedgerStrictMode()) {
        recordLedgerStrictViolation(message);
        throw new Error(message);
      }
      this.logger.warn(message);
    }
    return new Ledger(normalized);
  };

  /**
   * Commit the ledger to the storage layer as one unit-of-work.
   * @param {ILedger} ledger
   * @returns {Promise<void>}
   */
  public commit = async (
    _ledger: ILedger,
    trx?: Knex.Transaction,
  ): Promise<void> => {
    // The same rounded entries feed the ledger rows, the account and
    // contact balances and the analytics copy, so they can't drift apart.
    const ledger = await this.normalize(_ledger, trx);

    const tasks = [
      // Saves the ledger entries.
      this.ledgerEntriesService.saveEntries(ledger, trx),

      // Mutates the associated accounts balances.
      this.ledgerAccountsBalance.saveAccountsBalance(ledger, trx),

      // Mutates the associated contacts balances.
      this.ledgerContactsBalance.saveContactsBalance(ledger, trx),
    ];
    await Promise.all(tasks);

    // Queues the ledger deltas to the ClickHouse analytics store.
    this.ledgerClickHouseSink.onLedgerCommitted(ledger);
  };

  /**
   * Deletes the given ledger and revert balances.
   * @param {number} tenantId
   * @param {ILedger} ledger
   * @param {Knex.Transaction} trx
   * @returns {Promise<void>}
   */
  public delete = async (ledger: ILedger, trx?: Knex.Transaction) => {
    // Retrieves the deleted rows before the deletion to sync them to
    // the ClickHouse analytics store.
    const deletedEntryIds = ledger
      .getEntries()
      .filter((entry) => Boolean(entry.entryId))
      .map((entry) => entry.entryId);

    const deletedRows =
      deletedEntryIds.length > 0
        ? await this.accountTransactionModel()
            .query(trx)
            .whereIn('id', deletedEntryIds)
            .select('accountId', 'credit', 'debit', 'basis')
        : [];

    const tasks = [
      // Deletes the ledger entries.
      this.ledgerEntriesService.deleteEntries(ledger, trx),

      // Mutates the associated accounts balances.
      this.ledgerAccountsBalance.saveAccountsBalance(ledger, trx),

      // Mutates the associated contacts balances.
      this.ledgerContactsBalance.saveContactsBalance(ledger, trx),
    ];
    await Promise.all(tasks);

    // Queues the negated ledger deltas to the ClickHouse analytics store.
    this.ledgerClickHouseSink.onLedgerDeleted(deletedRows);
  };

  /**
   * Deletes the ledger entries by the given reference.
   * @param {number | number[]} referenceId - The reference ID.
   * @param {string | string[]} referenceType - The reference type.
   * @param {Knex.Transaction} trx - The knex transaction.
   * @param {{ basis?: AccountingBasis }} options - Deletes only the entries
   *  tagged with the given basis when set (e.g. to rewrite the cash set alone).
   */
  public deleteByReference = async (
    referenceId: number | number[],
    referenceType: string | string[],
    trx?: Knex.Transaction,
    options?: { basis?: AccountingBasis },
  ) => {
    // Retrieves the transactions of the given reference.
    const transactions = await this.accountTransactionModel()
      .query(trx)
      .modify('filterByReference', referenceId, referenceType)
      .onBuild((query) => {
        if (options?.basis) {
          query.where('basis', options.basis);
        }
      })
      .withGraphFetched('account');

    // Creates a new ledger from transaction and reverse the entries.
    const reversedLedger = Ledger.fromTransactions(transactions).reverse();

    // Deletes and reverts the balances.
    await this.delete(reversedLedger, trx);
  };
}
