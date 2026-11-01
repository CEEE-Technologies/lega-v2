import { Knex } from 'knex';
import { CreditNoteAccrualGL } from './CreditNoteAccrualGL';
import { Inject, Injectable } from '@nestjs/common';
import { LedgerStorageService } from '@/modules/Ledger/LedgerStorage.service';
import { CreditNote } from '../models/CreditNote';
import { AccountRepository } from '@/modules/Accounts/repositories/Account.repository';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';

@Injectable()
export class CreditNoteGLEntries {
  constructor(
    private readonly ledgerStorage: LedgerStorageService,
    private readonly accountRepository: AccountRepository,

    @Inject(CreditNote.name)
    private readonly creditNoteModel: TenantModelProxy<typeof CreditNote>,
  ) {}

  /**
   * Reverts the credit note associated GL entries.
   * @param {number} creditNoteId - Credit note id.
   * @param {Knex.Transaction} trx
   */
  public revertVendorCreditGLEntries = async (
    creditNoteId: number,
    trx?: Knex.Transaction,
  ): Promise<void> => {
    await this.ledgerStorage.deleteByReference(creditNoteId, 'CreditNote', trx);
  };

  /**
   * Writes vendor credit associated GL entries.
   * @param {number} creditNoteId - Credit note id.
   * @param {Knex.Transaction} trx - Knex transactions.
   */
  public createVendorCreditGLEntries = async (
    creditNoteId: number,
    trx?: Knex.Transaction,
  ): Promise<void> => {
    // Retrieve the credit note with associated entries and items.
    const creditNoteWithItems = await this.creditNoteModel()
      .query(trx)
      .findById(creditNoteId)
      .withGraphFetched('entries.item');

    // Retreive the the `accounts receivable` account based on the given currency.
    const ARAccount =
      await this.accountRepository.findOrCreateAccountReceivable(
        creditNoteWithItems.currencyCode,
        {},
        trx,
      );
    const discountAccount =
      await this.accountRepository.findOrCreateDiscountAccount({}, trx);

    const adjustmentAccount =
      await this.accountRepository.findOrCreateOtherChargesAccount({}, trx);

    const creditNoteLedger = new CreditNoteAccrualGL(creditNoteWithItems)
      .setARAccountId(ARAccount.id)
      .setDiscountAccountId(discountAccount.id)
      .setAdjustmentAccountId(adjustmentAccount.id)
      .getCreditNoteLedger();

    // Saves the credit note GL entries.
    await this.ledgerStorage.commit(creditNoteLedger, trx);
  };

  /**
   * Rewrites the credit note GL entries from its stored state: a published
   * credit note gets its journal rewritten, a draft has none.
   *
   * The stored row is read here because the graph an edit saves has only
   * the edited fields (no `openedAt` unless the edit publishes it), so it
   * always looked like a draft and an edit never rewrote the journal.
   * @param {number} creditNoteId - Credit note id.
   * @param {Knex.Transaction} trx
   */
  public rewriteCreditNoteGLEntries = async (
    creditNoteId: number,
    trx?: Knex.Transaction,
  ): Promise<void> => {
    const creditNote = await this.creditNoteModel()
      .query(trx)
      .findById(creditNoteId);

    if (!creditNote?.isPublished) {
      await this.revertVendorCreditGLEntries(creditNoteId, trx);
      return;
    }
    await this.editVendorCreditGLEntries(creditNoteId, trx);
  };

  /**
   * Edits vendor credit associated GL entries.
   * @param {number} creditNoteId - Credit note id.
   * @param {Knex.Transaction} trx
   */
  public editVendorCreditGLEntries = async (
    creditNoteId: number,
    trx?: Knex.Transaction,
  ): Promise<void> => {
    // Reverts vendor credit GL entries.
    await this.revertVendorCreditGLEntries(creditNoteId, trx);

    // Creates vendor credit Gl entries.
    await this.createVendorCreditGLEntries(creditNoteId, trx);
  };
}
