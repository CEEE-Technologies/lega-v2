import { Inject, Injectable } from '@nestjs/common';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { InventoryTransactionsService } from '@/modules/InventoryCost/commands/InventoryTransactions.service';
import { ItemsEntriesService } from '@/modules/Items/ItemsEntries.service';
import { CreditNote } from '../models/CreditNote';
import { Knex } from 'knex';
import { IInventoryTransactionFromItemsEntries } from '@/modules/InventoryCost/types/InventoryCost.types';
@Injectable()
export class CreditNoteInventoryTransactions {
  constructor(
    private readonly inventoryService: InventoryTransactionsService,
    private readonly itemsEntriesService: ItemsEntriesService,

    @Inject(CreditNote.name)
    private readonly creditNoteModel?: TenantModelProxy<typeof CreditNote>,
  ) {}

  /**
   * Rewrites the stock movement of the given credit note from its stored
   * state: a published credit note returns its goods, a draft none.
   * @param {number} creditNoteId - Credit note id.
   * @param {Knex.Transaction} trx
   */
  public rewriteInventoryTransactions = async (
    creditNoteId: number,
    trx?: Knex.Transaction,
  ): Promise<void> => {
    const creditNote = await this.creditNoteModel()
      .query(trx)
      .findById(creditNoteId)
      .withGraphFetched('entries');

    if (!creditNote?.isPublished) {
      await this.deleteInventoryTransactions(creditNoteId, trx);
      return;
    }
    await this.editInventoryTransactions(creditNoteId, creditNote, trx);
  };

  /**
   * Creates credit note inventory transactions. The returned goods come
   * back into stock at the item's average cost at the credit note date (the
   * cost lots, InventoryAverageCostMethod): the entry rate is the selling
   * price and only kept on the movement for reference.
   * @param {number} tenantId
   * @param {ICreditNote} creditNote
   */
  public createInventoryTransactions = async (
    creditNote: CreditNote,
    trx?: Knex.Transaction,
  ): Promise<void> => {
    // Loads the inventory items entries of the given sale invoice.
    const inventoryEntries =
      await this.itemsEntriesService.filterInventoryEntries(creditNote.entries);

    const transaction: IInventoryTransactionFromItemsEntries = {
      transactionId: creditNote.id,
      transactionType: 'CreditNote',
      transactionNumber: creditNote.creditNoteNumber,
      exchangeRate: creditNote.exchangeRate,
      date: creditNote.creditNoteDate,
      direction: 'IN',
      entries: inventoryEntries,
      createdAt: creditNote.createdAt,
      warehouseId: creditNote.warehouseId,
    };
    // Writes inventory tranactions.
    await this.inventoryService.recordInventoryTransactionsFromItemsEntries(
      transaction,
      false,
      trx,
    );
  };

  /**
   * Edits vendor credit associated inventory transactions.
   * @param {number} tenantId
   * @param {number} creditNoteId
   * @param {ICreditNote} creditNote
   * @param {Knex.Transactions} trx
   */
  public editInventoryTransactions = async (
    creditNoteId: number,
    creditNote: CreditNote,
    trx?: Knex.Transaction,
  ): Promise<void> => {
    // Deletes inventory transactions.
    await this.deleteInventoryTransactions(creditNoteId, trx);

    // Re-write inventory transactions.
    await this.createInventoryTransactions(creditNote, trx);
  };

  /**
   * Deletes credit note associated inventory transactions.
   * @param {number} tenantId - Tenant id.
   * @param {number} creditNoteId - Credit note id.
   * @param {Knex.Transaction} trx -
   */
  public deleteInventoryTransactions = async (
    creditNoteId: number,
    trx?: Knex.Transaction,
  ): Promise<void> => {
    // Deletes the inventory transactions by the given reference id and type.
    await this.inventoryService.deleteInventoryTransactions(
      creditNoteId,
      'CreditNote',
      trx,
    );
  };
}
