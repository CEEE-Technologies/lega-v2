import { AccountTransaction } from '@/modules/Accounts/models/AccountTransaction.model';
import { AccountRepository } from '@/modules/Accounts/repositories/Account.repository';
import { Contact } from '@/modules/Contacts/models/Contact';
import { Ledger } from '@/modules/Ledger/Ledger';
import { AccountingBasis } from '@/common/types/AccountingBasis';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { TenancyContext } from '@/modules/Tenancy/TenancyContext.service';
import { transformToMap } from '@/utils/transform-to-key';
import { Inject } from '@nestjs/common';
import { ModelObject } from 'objection';
import { castArray, isNumber } from 'lodash';
import { AccountingBasisService } from '../../common/AccountingBasisService';

export class JournalSheetRepository {
  @Inject(TenancyContext)
  private tenancyContext: TenancyContext;

  @Inject(AccountRepository)
  private accountRepository: AccountRepository;

  @Inject(Contact.name)
  private contactModel: TenantModelProxy<typeof Contact>;

  @Inject(AccountTransaction.name)
  private accountTransaction: TenantModelProxy<typeof AccountTransaction>;

  @Inject(AccountTransaction.name)
  private accountTransactions: Array<ModelObject<AccountTransaction>>;

  @Inject(AccountingBasisService)
  private accountingBasisService: AccountingBasisService;

  /**
   * The report accounting basis.
   */
  public basis: AccountingBasis;

  /**
   *
   */
  public filter: any;

  /**
   *
   */
  public accountsGraph: any;

  /**
   *
   */
  public contacts: Array<ModelObject<Contact>>;

  /**
   * Contacts by id map.
   */
  public contactsById: Map<number, ModelObject<Contact>>;

  /**
   *
   */
  public ledger: Ledger;

  public baseCurrency: string;

  setFilter(filter: any) {
    this.filter = filter;
  }

  /**
   * Loads the journal sheet data.
   */
  async load() {
    await this.initBaseCurrency();
    await this.initBasis();
    await this.initAccountsGraph();
    await this.initAccountTransactions();
    await this.initContacts();
    await this.initLedger();
  }

  /**
   * Initialize the report accounting basis.
   */
  async initBasis() {
    this.basis = await this.accountingBasisService.resolve(this.filter?.basis);
  }

  /**
   * Initialize base currency.
   */
  async initBaseCurrency() {
    const metadata = await this.tenancyContext.getTenantMetadata();

    this.baseCurrency = metadata.baseCurrency;
  }

  /**
   * Initialize accounts graph.
   */
  async initAccountsGraph() {
    // Retrieve all accounts on the storage.
    const accountsGraph = await this.accountRepository.getDependencyGraph();
    this.accountsGraph = accountsGraph;
  }

  /**
   * Initialize account transactions.
   */
  async initAccountTransactions() {
    // Retrieve all journal transactions based on the given query.
    const transactions = await this.accountTransaction()
      .query()
      .onBuild((query) => {
        // Each line is either a debit or a credit (the other side is 0), so
        // the line amount is debit + credit. Comparing each side on its own
        // let every line through "to" (its 0 side is always below it).
        if (isNumber(this.filter.fromRange)) {
          query.whereRaw('(COALESCE(debit, 0) + COALESCE(credit, 0)) >= ?', [
            this.filter.fromRange,
          ]);
        }
        if (isNumber(this.filter.toRange)) {
          query.whereRaw('(COALESCE(debit, 0) + COALESCE(credit, 0)) <= ?', [
            this.filter.toRange,
          ]);
        }
        const accountsIds = castArray(this.filter.accountsIds ?? []).filter(
          (id) => isNumber(id),
        );
        if (accountsIds.length > 0) {
          query.whereIn('account_id', accountsIds);
        }
        query.modify(
          'filterDateRange',
          this.filter.fromDate,
          this.filter.toDate,
        );
        query.orderBy(['date', 'createdAt', 'indexGroup', 'index']);

        if (this.filter.transactionType) {
          query.where('reference_type', this.filter.transactionType);
        }
        if (this.filter.transactionType && this.filter.transactionId) {
          query.where('reference_id', this.filter.transactionId);
        }
        query.modify('filterByBasis', this.basis);
        query.withGraphFetched('account');
      });
    this.accountTransactions = transactions;
  }

  /**
   * Initialize contacts.
   */
  async initContacts() {
    const contacts = await this.contactModel().query();

    this.contacts = contacts;
    this.contactsById = transformToMap(contacts, 'id');
  }

  async initLedger() {
    this.ledger = Ledger.fromTransactions(this.accountTransactions);
  }
}
