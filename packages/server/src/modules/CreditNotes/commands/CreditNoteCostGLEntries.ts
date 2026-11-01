import { Knex } from 'knex';
import { Inject, Injectable } from '@nestjs/common';
import { keyBy } from 'lodash';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { InventoryCostLotTracker } from '@/modules/InventoryCost/models/InventoryCostLotTracker';
import { LedgerStorageService } from '@/modules/Ledger/LedgerStorage.service';
import { Ledger } from '@/modules/Ledger/Ledger';
import { ILedgerEntry } from '@/modules/Ledger/types/Ledger.types';
import { AccountingBasis } from '@/common/types/AccountingBasis';
import { getCostLotsGLEntries } from '@/modules/InventoryCost/InventoryCostLotsGL';
import { CreditNote } from '../models/CreditNote';

/**
 * Writes the cost entries of the goods customers return on credit notes:
 * the returned units go back into stock at their cost (the average cost at
 * the credit note date, see the cost lots), so the cost of sales the sale
 * recorded is reversed.
 * -----
 * - Inventory -> Debit -> cost
 *    - Cost of goods sold -> Credit -> cost
 * -----
 * Like the invoice cost entries they are accrual entries and `costable`:
 * the cost compute job rewrites them, so editing or deleting the credit
 * note, or a back-dated purchase, re-works them.
 */
@Injectable()
export class CreditNoteCostGLEntries {
  constructor(
    private readonly ledgerStorage: LedgerStorageService,

    @Inject(InventoryCostLotTracker.name)
    private readonly inventoryCostLotTracker: TenantModelProxy<
      typeof InventoryCostLotTracker
    >,

    @Inject(CreditNote.name)
    private readonly creditNoteModel: TenantModelProxy<typeof CreditNote>,
  ) {}

  /**
   * Retrieves the cost GL entries of the given credit notes return lots.
   * @param {InventoryCostLotTracker[]} lots - `IN` lots with `item` fetched.
   * @param {Record<number, CreditNote>} creditNotesById
   * @returns {ILedgerEntry[]}
   */
  public static getCostGLEntries(
    lots: InventoryCostLotTracker[],
    creditNotesById: Record<number, CreditNote>,
  ): ILedgerEntry[] {
    const costedLots = lots.filter(
      (lot) => creditNotesById[lot.transactionId] && lot.item,
    );
    return getCostLotsGLEntries(costedLots, {
      commonEntry: (lot) => {
        const creditNote = creditNotesById[lot.transactionId];

        return {
          currencyCode: creditNote.currencyCode,
          exchangeRate: creditNote.exchangeRate,
          transactionNumber: creditNote.creditNoteNumber,
          referenceNumber: creditNote.referenceNo,
          branchId: creditNote.branchId,
          userId: creditNote.userId,
          indexGroup: 20,
          basis: AccountingBasis.Accrual,
        };
      },
      debitAccountId: (lot) => lot.item.inventoryAccountId,
      creditAccountId: (lot) => lot.costAccountId || lot.item.costAccountId,
    });
  }

  /**
   * Writes the credit notes cost entries from the given date.
   * @param {Date} startingDate - Starting date.
   * @param {Knex.Transaction} trx
   */
  public writeInventoryCostJournalEntries = async (
    startingDate: Date,
    trx?: Knex.Transaction,
  ): Promise<void> => {
    const lots = await this.inventoryCostLotTracker()
      .query(trx)
      .where('direction', 'IN')
      .where('transaction_type', 'CreditNote')
      .where('cost', '>', 0)
      .modify('filterDateRange', startingDate)
      .orderBy('date', 'ASC')
      .withGraphFetched('item');

    if (lots.length === 0) return;

    const creditNotes = await this.creditNoteModel()
      .query(trx)
      .whereIn(
        'id',
        lots.map((lot) => lot.transactionId),
      );
    const entries = CreditNoteCostGLEntries.getCostGLEntries(
      lots,
      keyBy(creditNotes, 'id'),
    );
    await this.ledgerStorage.commit(new Ledger(entries), trx);
  };
}
