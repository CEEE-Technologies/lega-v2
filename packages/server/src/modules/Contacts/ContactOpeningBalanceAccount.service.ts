import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { AccountTransaction } from '@/modules/Accounts/models/AccountTransaction.model';
import { Account } from '@/modules/Accounts/models/Account.model';
import { OtherExpensesAccount } from '@/modules/Accounts/Accounts.constants';

type ContactKind = 'customer' | 'vendor';

const OPENING_BALANCE_TYPES: Record<ContactKind, string> = {
  customer: 'CustomerOpeningBalance',
  vendor: 'VendorOpeningBalance',
};

/**
 * Finds the account a contact opening balance was booked to: the income side
 * (Other Income) for customers and the expense side (Other Expenses) for
 * vendors. On the cash basis, paying the opening balance recognizes it on
 * that account.
 */
@Injectable()
export class ContactOpeningBalanceAccount {
  constructor(
    @Inject(AccountTransaction.name)
    private readonly accountTransactionModel: TenantModelProxy<
      typeof AccountTransaction
    >,

    @Inject(Account.name)
    private readonly accountModel: TenantModelProxy<typeof Account>,
  ) {}

  /**
   * Retrieves the customer opening balance account id.
   * @param {number} customerId
   * @param {Knex.Transaction} trx
   * @returns {Promise<number | null>}
   */
  public getCustomerAccountId(customerId: number, trx?: Knex.Transaction) {
    return this.getAccountId('customer', customerId, trx);
  }

  /**
   * Retrieves the vendor opening balance account id.
   * @param {number} vendorId
   * @param {Knex.Transaction} trx
   * @returns {Promise<number | null>}
   */
  public getVendorAccountId(vendorId: number, trx?: Knex.Transaction) {
    return this.getAccountId('vendor', vendorId, trx);
  }

  /**
   * Reads the account from the opening balance ledger entry. Falls back to
   * the default account when the entry is missing (or being rewritten).
   */
  private async getAccountId(
    kind: ContactKind,
    contactId: number,
    trx?: Knex.Transaction,
  ): Promise<number | null> {
    const entry = await this.accountTransactionModel()
      .query(trx)
      .where('reference_type', OPENING_BALANCE_TYPES[kind])
      .where('reference_id', contactId)
      .where(kind === 'customer' ? 'credit' : 'debit', '>', 0)
      .orderBy('id', 'asc')
      .first();

    if (entry?.accountId) {
      return entry.accountId;
    }
    const fallbackSlug =
      kind === 'customer' ? 'other-income' : OtherExpensesAccount.slug;
    const account = await this.accountModel()
      .query(trx)
      .findOne({ slug: fallbackSlug });

    return account?.id ?? null;
  }
}
