import { Inject, Injectable } from '@nestjs/common';
import { Knex } from 'knex';
import { roundMoney } from '@bigcapital/utils';
import { Account } from '@/modules/Accounts/models/Account.model';
import { AccountRepository } from '@/modules/Accounts/repositories/Account.repository';
import { LedgerStorageService } from '@/modules/Ledger/LedgerStorage.service';
import { SaleInvoice } from '../../models/SaleInvoice';
import { SaleInvoiceWriteoffGL } from './SaleInvoiceWriteoffGL';
import { getLockedPeriodChecker } from '@/modules/AccountingBasis/MoneyHealthCheck';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';

@Injectable()
export class SaleInvoiceWriteoffGLStorage {
  /**
   * @param {LedgerStorageService} ledgerStorage - Ledger storage service.
   * @param {AccountRepository} accountRepository - Account repository.
   * @param {Account} accountModel - Account model.
   * @param {SaleInvoice} saleInvoiceModel - Sale invoice model.
   */
  constructor(
    private readonly ledgerStorage: LedgerStorageService,
    private readonly accountRepository: AccountRepository,

    @Inject(Account.name)
    private readonly accountModel: TenantModelProxy<typeof Account>,
    @Inject(SaleInvoice.name)
    private readonly saleInvoiceModel: TenantModelProxy<typeof SaleInvoice>,
  ) {}

  /**
   * Writes the invoice write-off GL entries.
   * @param {number} saleInvoiceId - Sale invoice id.
   * @param {Knex.Transaction} trx - Knex transaction.
   * @returns {Promise<void>}
   */
  public async writeInvoiceWriteoffEntries(
    saleInvoiceId: number,
    trx?: Knex.Transaction,
  ) {
    // Retrieves the sale invoice.
    const saleInvoice = await this.saleInvoiceModel()
      .query(trx)
      .findById(saleInvoiceId)
      .withGraphFetched('writtenoffExpenseAccount');

    // The write-off is the remainder on top of the payments and credits
    // (see writtenoffAmountLocal): read them from their rows, so a rebuild
    // right after a payment or credit change doesn't use a total not yet
    // synced on the invoice.
    const knex = trx ?? this.saleInvoiceModel().knex();
    const [paid] = await knex('payment_receives_entries')
      .where('invoice_id', saleInvoiceId)
      .where((b) =>
        b.whereNull('entry_type').orWhereNot('entry_type', 'opening_balance'),
      )
      .sum('payment_amount as amount');
    const [credited] = await knex('credit_note_applied_invoice')
      .where('invoice_id', saleInvoiceId)
      .sum('amount as amount');
    saleInvoice.paymentAmount = roundMoney(Number(paid?.amount || 0));
    saleInvoice.creditedAmount = roundMoney(Number(credited?.amount || 0));

    // Find or create the A/R account.
    const ARAccount =
      await this.accountRepository.findOrCreateAccountReceivable(
        saleInvoice.currencyCode,
        {},
        trx,
      );
    const ledger = new SaleInvoiceWriteoffGL(saleInvoice)
      .setARAccountId(ARAccount.id)
      .getInvoiceWriteoffLedger();

    return this.ledgerStorage.commit(ledger, trx);
  }

  /**
   * Rewrites the invoice write-off GL entries.
   * @param {number} saleInvoiceId - Sale invoice id.
   * @param {Knex.Transaction} trx - Knex transaction.
   * @returns {Promise<void>}
   */
  public async rewriteInvoiceWriteoffEntries(
    saleInvoiceId: number,
    trx?: Knex.Transaction,
  ) {
    await this.revertInvoiceWriteoffEntries(saleInvoiceId, trx);
    await this.writeInvoiceWriteoffEntries(saleInvoiceId, trx);
  }

  /**
   * Reverts the invoice write-off GL entries.
   * @param {number} saleInvoiceId - Sale invoice id.
   * @param {Knex.Transaction} trx - Knex transaction.
   * @returns {Promise<void>}
   */
  /**
   * Rebuilds the write-off of the given invoices that are written off, as
   * their payments or applied credits changed (the write-off is what they
   * leave). A write-off in a locked period is left as it is.
   * @param {number[]} saleInvoiceIds
   * @param {Knex.Transaction} trx
   */
  public async rewriteWrittenoffInvoicesEntries(
    saleInvoiceIds: number[],
    trx?: Knex.Transaction,
  ) {
    const ids = [...new Set(saleInvoiceIds.filter(Boolean))];
    if (ids.length === 0) return;

    const invoices = await this.saleInvoiceModel()
      .query(trx)
      .whereIn('id', ids)
      .whereNotNull('writtenoff_at')
      .select('id', 'invoice_date');
    if (invoices.length === 0) return;

    const isLocked = await getLockedPeriodChecker(
      (trx ?? this.saleInvoiceModel().knex()) as Knex,
    );
    for (const invoice of invoices) {
      if (isLocked(invoice.invoiceDate, 'InvoiceWriteOff')) continue;
      await this.rewriteInvoiceWriteoffEntries(invoice.id, trx);
    }
  }

  /**
   * Rebuilds the write-off of every written-off invoice (the money repair).
   * @returns {Promise<number>} The number of written-off invoices.
   */
  public async rewriteAllWrittenoffInvoicesEntries(): Promise<number> {
    const invoices = await this.saleInvoiceModel()
      .query()
      .whereNotNull('writtenoff_at')
      .select('id');
    await this.saleInvoiceModel()
      .knex()
      .transaction((trx) =>
        this.rewriteWrittenoffInvoicesEntries(
          invoices.map((invoice) => invoice.id),
          trx,
        ),
      );
    return invoices.length;
  }

  public revertInvoiceWriteoffEntries = async (
    saleInvoiceId: number,
    trx?: Knex.Transaction,
  ) => {
    await this.ledgerStorage.deleteByReference(
      saleInvoiceId,
      'InvoiceWriteOff',
      trx,
    );
  };
}
