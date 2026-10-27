import {
  CREDIT_NOTE_REFUND_PAID_BEFORE,
  getDocumentsPaidBefore,
  getLaterPayments,
  rewritePaymentsInOrder,
} from '@/modules/AccountingBasis/CashBasisPaidBefore';
import { LedgerStorageService } from '@/modules/Ledger/LedgerStorage.service';
import { Inject, Injectable } from '@nestjs/common';
import { RefundCreditNote } from '../models/RefundCreditNote';
import { Ledger } from '@/modules/Ledger/Ledger';
import { Knex } from 'knex';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { Account } from '@/modules/Accounts/models/Account.model';
import { ILedgerEntry } from '@/modules/Ledger/types/Ledger.types';
import { AccountNormal } from '@/interfaces/Account';
import { AccountingBasis } from '@/common/types/AccountingBasis';
import { AccountRepository } from '@/modules/Accounts/repositories/Account.repository';
import { RefundCreditNoteCashGL } from './RefundCreditNoteCashGL';

@Injectable()
export class RefundCreditNoteGLEntries {
  constructor(
    private readonly ledgerStorage: LedgerStorageService,
    private readonly accountRepository: AccountRepository,

    @Inject(Account.name)
    private readonly accountModel: TenantModelProxy<typeof Account>,

    @Inject(RefundCreditNote.name)
    private readonly refundCreditNoteModel: TenantModelProxy<
      typeof RefundCreditNote
    >,
  ) {}

  /**
   * Retrieves the refund credit common GL entry.
   * @param {IRefundCreditNote} refundCreditNote
   * @returns
   */
  private getRefundCreditCommonGLEntry = (
    refundCreditNote: RefundCreditNote,
  ) => {
    return {
      currencyCode: refundCreditNote.currencyCode,
      exchangeRate: refundCreditNote.exchangeRate,

      transactionType: 'RefundCreditNote',
      transactionId: refundCreditNote.id,
      date: refundCreditNote.date,
      userId: refundCreditNote.userId,

      referenceNumber: refundCreditNote.referenceNo,

      createdAt: refundCreditNote.createdAt,
      indexGroup: 10,

      credit: 0,
      debit: 0,

      note: refundCreditNote.description,
      branchId: refundCreditNote.branchId,

      basis: AccountingBasis.Accrual,
    };
  };

  /**
   * Retrieves the refudn credit receivable GL entry.
   * @param   {IRefundCreditNote} refundCreditNote
   * @param   {number} ARAccountId
   * @returns {ILedgerEntry}
   */
  private getRefundCreditGLReceivableEntry = (
    refundCreditNote: RefundCreditNote,
    ARAccountId: number,
  ): ILedgerEntry => {
    const commonEntry = this.getRefundCreditCommonGLEntry(refundCreditNote);

    return {
      ...commonEntry,
      debit: refundCreditNote.amount,
      accountId: ARAccountId,
      contactId: refundCreditNote.creditNote.customerId,
      index: 1,
      accountNormal: AccountNormal.DEBIT,
    };
  };

  /**
   * Retrieves the refund credit withdrawal GL entry.
   * @param   {number} refundCreditNote
   * @returns {ILedgerEntry}
   */
  private getRefundCreditGLWithdrawalEntry = (
    refundCreditNote: RefundCreditNote,
  ): ILedgerEntry => {
    const commonEntry = this.getRefundCreditCommonGLEntry(refundCreditNote);

    return {
      ...commonEntry,
      credit: refundCreditNote.amount,
      accountId: refundCreditNote.fromAccountId,
      index: 2,
      accountNormal: AccountNormal.DEBIT,
    };
  };

  /**
   * Retrieve the refund credit note GL entries.
   * @param {IRefundCreditNote} refundCreditNote
   * @param {number} receivableAccount
   * @returns {ILedgerEntry[]}
   */
  public getRefundCreditGLEntries(
    refundCreditNote: RefundCreditNote,
    ARAccountId: number,
  ): ILedgerEntry[] {
    const receivableEntry = this.getRefundCreditGLReceivableEntry(
      refundCreditNote,
      ARAccountId,
    );
    const withdrawalEntry =
      this.getRefundCreditGLWithdrawalEntry(refundCreditNote);

    return [receivableEntry, withdrawalEntry];
  }

  /**
   * Retrieves the refund credit note general ledger.
   * The ledger contains both the accrual basis entries (A/R/payment) and
   * the cash basis entries (withdrawal/income) flagged by the basis.
   * @param {RefundCreditNote} refundCreditNote - Refund credit note.
   * @param {number} ARAccountId - A/R account id.
   * @param {Knex.Transaction} trx - Knex transaction.
   * @returns {Promise<Ledger>}
   */
  public getRefundCreditNoteGLedger = async (
    refundCreditNote: RefundCreditNote,
    ARAccountId: number,
    trx?: Knex.Transaction,
  ): Promise<Ledger> => {
    // Accrual basis ledger entries.
    const accrualLedger = new Ledger(
      this.getRefundCreditGLEntries(refundCreditNote, ARAccountId),
    );

    // Cash basis ledger entries.
    const cashLedger = await this.getRefundCreditNoteCashLedger(
      refundCreditNote,
      trx,
    );
    return new Ledger([
      ...accrualLedger.getEntries(),
      ...cashLedger.getEntries(),
    ]);
  };

  /**
   * Retrieves the refund credit note cash basis ledger.
   * @param {RefundCreditNote} refundCreditNote - Refund credit note.
   * @param {Knex.Transaction} trx - Knex transaction.
   * @returns {Promise<Ledger>}
   */
  public getRefundCreditNoteCashLedger = async (
    refundCreditNote: RefundCreditNote,
    trx?: Knex.Transaction,
  ): Promise<Ledger> => {
    // Find or create the discount account.
    const discountAccount =
      await this.accountRepository.findOrCreateDiscountAccount({}, trx);
    // Find or create the other charges (adjustment) account.
    const adjustmentAccount =
      await this.accountRepository.findOrCreateOtherChargesAccount({}, trx);

    // What the earlier refunds took of the credit note: the running-total
    // split of this refund starts from there.
    const refundedBefore = await getDocumentsPaidBefore(
      trx ?? this.refundCreditNoteModel().knex(),
      CREDIT_NOTE_REFUND_PAID_BEFORE,
      { id: refundCreditNote.id, date: refundCreditNote.date },
      [refundCreditNote.creditNoteId],
      !!trx,
    );
    // A credit note with no income to reverse (or a refund above what is
    // left of it) takes the refund from the customer's unearned revenue.
    const unearnedRevenueAccount =
      await this.accountRepository.findOrCreateUnearnedRevenue({}, trx);

    const refundCreditNoteCashGL = new RefundCreditNoteCashGL(refundCreditNote)
      .setRefundedBefore(refundedBefore[refundCreditNote.creditNoteId] || 0)
      .setDiscountAccountId(discountAccount.id)
      .setAdjustmentAccountId(adjustmentAccount.id)
      .setUnearnedRevenueAccountId(unearnedRevenueAccount.id);
    return refundCreditNoteCashGL.getLedger();
  };

  /**
   * Rewrites only the cash basis entries of the given refund, e.g. once the
   * credit note is edited, leaving the accrual entries and balances alone.
   * @param {number} refundCreditNoteId - Refund credit note id.
   * @param {Knex.Transaction} trx - Knex transaction.
   */
  public rewriteRefundCreditCashGLEntries = async (
    refundCreditNoteId: number,
    trx?: Knex.Transaction,
  ) => {
    await this.ledgerStorage.deleteByReference(
      refundCreditNoteId,
      'RefundCreditNote',
      trx,
      { basis: AccountingBasis.Cash },
    );
    const refundCreditNote = await this.refundCreditNoteModel()
      .query(trx)
      .findById(refundCreditNoteId)
      .withGraphFetched('creditNote.entries.item');

    if (!refundCreditNote) return;

    const cashLedger = await this.getRefundCreditNoteCashLedger(
      refundCreditNote,
      trx,
    );
    await this.ledgerStorage.commit(cashLedger, trx);
  };

  /**
   * Retrieves the refunds of the given credit note, whose cash entries a
   * credit note edit rewrites.
   * @param {number} creditNoteId - Credit note id.
   * @param {Knex.Transaction} trx - Knex transaction.
   */
  public getCreditNoteRefunds = async (
    creditNoteId: number,
    trx?: Knex.Transaction,
  ) => {
    const refunds = await this.refundCreditNoteModel()
      .query(trx)
      .where('creditNoteId', creditNoteId);

    return refunds.map((refund) => ({
      label: refund.referenceNo ? `Refund ${refund.referenceNo}` : 'A refund',
      date: refund.date,
    }));
  };

  /**
   * Rewrites the cash basis entries of all the refunds of the given credit
   * note.
   * @param {number} creditNoteId - Credit note id.
   * @param {Knex.Transaction} trx - Knex transaction.
   */
  public rewriteCreditNoteRefundsCashGLEntries = async (
    creditNoteId: number,
    trx?: Knex.Transaction,
  ) => {
    const refunds = await this.refundCreditNoteModel()
      .query(trx)
      .where('creditNoteId', creditNoteId)
      // In date, then id order: each refund's split starts from the earlier.
      .orderBy([
        { column: 'date', order: 'asc' },
        { column: 'id', order: 'asc' },
      ]);

    for (const refund of refunds) {
      await this.rewriteRefundCreditCashGLEntries(refund.id, trx);
    }
  };

  /**
   * Creates refund credit GL entries.
   * @param {IRefundCreditNote} refundCreditNote
   * @param {Knex.Transaction} trx
   */
  public createRefundCreditGLEntries = async (
    refundCreditNoteId: number,
    trx?: Knex.Transaction,
  ) => {
    // Retrieve the refund with associated credit note and items.
    const refundCreditNote = await this.refundCreditNoteModel()
      .query(trx)
      .findById(refundCreditNoteId)
      .withGraphFetched('creditNote.entries.item');

    // Receivable account A/R.
    const receivableAccount = await this.accountModel()
      .query()
      .findOne('slug', 'accounts-receivable');

    // Retrieve refund credit ledger entries.
    const ledger = await this.getRefundCreditNoteGLedger(
      refundCreditNote,
      receivableAccount.id,
      trx,
    );

    // Saves refund ledger entries.
    await this.ledgerStorage.commit(ledger, trx);
  };

  /**
   * Reverts refund credit note GL entries.
   * @param {number} refundCreditNoteId
   * @param {number} receivableAccount
   * @param {Knex.Transaction} trx
   */
  public revertRefundCreditGLEntries = async (
    refundCreditNoteId: number,
    trx?: Knex.Transaction,
  ) => {
    await this.ledgerStorage.deleteByReference(
      refundCreditNoteId,
      'RefundCreditNote',
      trx,
    );
  };
  /**
   * Rebuilds, one at a time and in order, the cash basis entries of the
   * refunds of the credit note that come after the given position (date, then
   * id): their running-total split starts from the refunds before them.
   * Refunds in a locked period are skipped (and logged).
   * @param {number} creditNoteId
   * @param {{ id: number; date: any }} after - The position to start after.
   * @param {Knex.Transaction} trx
   */
  public rewriteLaterRefundsCashGLEntries = async (
    creditNoteId: number,
    after: { id: number; date: any },
    trx?: Knex.Transaction,
  ): Promise<void> => {
    const knex = trx ?? this.refundCreditNoteModel().knex();
    const laterRefunds = await getLaterPayments(
      knex,
      CREDIT_NOTE_REFUND_PAID_BEFORE,
      [creditNoteId],
      after,
    );
    await rewritePaymentsInOrder(
      knex,
      laterRefunds.filter((refund) => refund.id !== after.id),
      'RefundCreditNote',
      (refundId) => this.rewriteRefundCreditCashGLEntries(refundId, trx),
    );
  };
}
