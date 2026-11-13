import { OnEvent } from '@nestjs/event-emitter';
import { Inject, Injectable } from '@nestjs/common';
import { IAccountEventDeletedPayload } from '@/interfaces/Account';
import { events } from '@/common/events/events';
import { PlaidItem } from '@/modules/BankingPlaid/models/PlaidItem';
import { Account } from '@/modules/Accounts/models/Account.model';
import { PlaidApi } from 'plaid';
import { PLAID_CLIENT } from '@/modules/Plaid/Plaid.module';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { runAfterTransaction } from '@/modules/Tenancy/TenancyDB/TransactionsHooks';

@Injectable()
export class DisconnectPlaidItemOnAccountDeleted {
  constructor(
    @Inject(PLAID_CLIENT) private plaidClient: PlaidApi,

    @Inject(PlaidItem.name)
    private plaidItemModel: TenantModelProxy<typeof PlaidItem>,

    @Inject(Account.name)
    private accountModel: TenantModelProxy<typeof Account>,
  ) {}

  /**
   * Unlinks the Plaid item inside the account delete, then disconnects it
   * from Plaid once the delete is committed. A dry run or a delete that is
   * undone later keeps the bank connection.
   * @param {IAccountEventDeletedPayload} payload
   * @returns {Promise<void>}
   */
  @OnEvent(events.accounts.onDeleted)
  public async handleDisconnectPlaidItemOnAccountDelete({
    oldAccount,
    trx,
  }: IAccountEventDeletedPayload) {
    // Can't continue if the deleted account is not linked to Plaid item.
    if (!oldAccount.plaidItemId) return;

    // Retrieves the Plaid item that associated to the deleted account.
    const oldPlaidItem = await this.plaidItemModel()
      .query(trx)
      .findOne('plaidItemId', oldAccount.plaidItemId);
    // Unlink the Plaid item from all account before deleting it.
    await this.accountModel()
      .query(trx)
      .where('plaidItemId', oldAccount.plaidItemId)
      .patch({
        plaidAccountId: null,
        plaidItemId: null,
      });
    // Remove the Plaid item from the system.
    await this.plaidItemModel()
      .query(trx)
      .findOne('plaidItemId', oldAccount.plaidItemId)
      .delete();

    // Tell Plaid only once the delete is committed. The call can't be
    // undone, so it must not run for a dry run or a delete that fails.
    if (oldPlaidItem) {
      runAfterTransaction(trx, async () => {
        try {
          await this.plaidClient.itemRemove({
            access_token: oldPlaidItem.plaidAccessToken,
          });
        } catch (error) {
          console.error('[plaid] Failed to disconnect the Plaid item:', error);
        }
      });
    }
  }
}
