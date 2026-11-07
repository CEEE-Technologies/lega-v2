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
import { subtractMoney } from '@bigcapital/utils';
import { TenancyContext } from '@/modules/Tenancy/TenancyContext.service';
import {
  getExchangeGainLossEntries,
  getRunningTotalRelief,
  IRefundExchangeGainLoss,
} from '@/utils/exchange-gain-loss';
import {
  getRefundLocalAmount,
  RefundCreditNoteCashGL,
} from './RefundCreditNoteCashGL';

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

    private readonly tenancyContext?: TenancyContext,
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
      debit: getRefundLocalAmount(refundCreditNote),
      foreignDebit: refundCreditNote.amount,
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
      credit: getRefundLocalAmount(refundCreditNote),
      foreignCredit: refundCreditNote.amount,
      accountId: refundCreditNote.fromAccountId,
      index: 2,
      accountNormal: AccountNormal.DEBIT,
    };
  };

  /**
   * Retrieves the exchange gain/loss lines of the refund. The credit note
   * credited A/R at its own rate; the refund relieves A/R at that rate (a
   * running total over the credit note's refunds), as a payment relieves
   * A/R at the invoice rate. The A/R line is at the refund rate, so this
   * pair moves the difference from A/R to exchange gain/loss: a refund at
   * a higher rate than the credit note's is a loss.
   * @param {RefundCreditNote} refundCreditNote
   * @param {number} ARAccountId
   * @param {IRefundExchangeGainLoss} fx
   * @returns {ILedgerEntry[]}
   */
  private getRefundCreditGLExchangeGainLossEntries = (
    refundCreditNote: RefundCreditNote,
    ARAccountId: number,
    fx?: IRefundExchangeGainLoss,
  ): ILedgerEntry[] => {
    const creditNote = refundCreditNote.creditNote;
    if (!fx?.exchangeGainOrLossAccountId || !creditNote) return [];

    const relief = getRunningTotalRelief(
      refundCreditNote.amount,
      fx.refundedBefore,
      creditNote.exchangeRate ?? refundCreditNote.exchangeRate ?? 1,
    );
    const entries = getExchangeGainLossEntries({
      commonEntry: this.getRefundCreditCommonGLEntry(refundCreditNote),
      // > 0 debits A/R: the A/R line (at the refund rate) took less than
      // the relief.
      amount: subtractMoney(relief, getRefundLocalAmount(refundCreditNote)),
      baseCurrencyCode: fx.baseCurrencyCode,
      contactEntry: {
        accountId: ARAccountId,
        contactId: creditNote.customerId,
        index: 3,
        accountNormal: AccountNormal.DEBIT,
      },
      gainLossEntry: {
        accountId: fx.exchangeGainOrLossAccountId,
        index: 3,
        accountNormal: AccountNormal.DEBIT,
      },
    });
    return entries ? [entries.contactEntry, entries.gainLossEntry] : [];
  };

  /**
   * Retrieve the refund credit note GL entries.
   * @param {IRefundCreditNote} refundCreditNote
   * @param {number} receivableAccount
   * @param {IRefundExchangeGainLoss} fx - Without it, no exchange gain/loss.
   * @returns {ILedgerEntry[]}
   */
  public getRefundCreditGLEntries(
    refundCreditNote: RefundCreditNote,
    ARAccountId: number,
    fx?: IRefundExchangeGainLoss,
  ): ILedgerEntry[] {
    const receivableEntry = this.getRefundCreditGLReceivableEntry(
      refundCreditNote,
      ARAccountId,
    );
    const withdrawalEntry =
      this.getRefundCreditGLWithdrawalEntry(refundCreditNote);

    return [
      receivableEntry,
      withdrawalEntry,
      ...this.getRefundCreditGLExchangeGainLossEntries(
        refundCreditNote,
        ARAccountId,
        fx,
      ),
    ];
  }

  /**
   * What the refunds before this one (date, then id) took of the credit
   * note. Locks the credit note in a transaction.
   * @param {RefundCreditNote} refundCreditNote
   * @param {Knex.Transaction} trx
   * @returns {Promise<number>}
   */
  private getRefundedBefore = async (
    refundCreditNote: RefundCreditNote,
    trx?: Knex.Transaction,
  ): Promise<number> => {
    const refundedBefore = await getDocumentsPaidBefore(
      trx ?? this.refundCreditNoteModel().knex(),
      CREDIT_NOTE_REFUND_PAID_BEFORE,
      { id: refundCreditNote.id, date: refundCreditNote.date },
      [refundCreditNote.creditNoteId],
      !!trx,
    );
    return refundedBefore[refundCreditNote.creditNoteId] || 0;
  };

  /**
   * Retrieves what the accrual journal needs for the exchange gain/loss.
   * @param {RefundCreditNote} refundCreditNote
   * @param {Knex.Transaction} trx
   * @returns {Promise<IRefundExchangeGainLoss>}
   */
  private getRefundExchangeGainLoss = async (
    refundCreditNote: RefundCreditNote,
    trx?: Knex.Transaction,
  ): Promise<IRefundExchangeGainLoss> => {
    const exGainLossAccount = await this.accountModel()
      .query(trx)
      .modify('findBySlug', 'exchange-grain-loss')
      .first();
    const tenantMeta = await this.tenancyContext?.getTenantMetadata();

    return {
      exchangeGainOrLossAccountId: exGainLossAccount?.id ?? null,
      baseCurrencyCode: tenantMeta?.baseCurrency,
      refundedBefore: await this.getRefundedBefore(refundCreditNote, trx),
    };
  };

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
      this.getRefundCreditGLEntries(
        refundCreditNote,
        ARAccountId,
        await this.getRefundExchangeGainLoss(refundCreditNote, trx),
      ),
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
    const refundedBefore = await this.getRefundedBefore(refundCreditNote, trx);
    // A credit note with no income to reverse (or a refund above what is
    // left of it) takes the refund from the customer's unearned revenue.
    const unearnedRevenueAccount =
      await this.accountRepository.findOrCreateUnearnedRevenue({}, trx);

    const refundCreditNoteCashGL = new RefundCreditNoteCashGL(refundCreditNote)
      .setRefundedBefore(refundedBefore)
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
   * Rewrites a refund whose position or credit note changed: its cash basis
   * entries, and its accrual ones too in a foreign currency (their A/R
   * relief is a running total at the credit note rate, so it moves with
   * the refunds before it and with the credit note's rate). In the base
   * currency the accrual entries never move.
   * @param {number} refundCreditNoteId
   * @param {Knex.Transaction} trx
   */
  private rewriteRefundOnChange = async (
    refundCreditNoteId: number,
    trx?: Knex.Transaction,
  ): Promise<void> => {
    const refund = await this.refundCreditNoteModel()
      .query(trx)
      .findById(refundCreditNoteId)
      .withGraphFetched('creditNote');
    if (!refund) return;

    // By the currency, not the rates: a foreign document edited to the
    // rate 1 (with a refund at 1) still has to drop the exchange gain/loss
    // its accrual entries were posted with at the old rate.
    const baseCurrency = (await this.tenancyContext?.getTenantMetadata())
      ?.baseCurrency;
    const currencyCode = refund.currencyCode ?? refund.creditNote?.currencyCode;
    const isForeign =
      (!!baseCurrency && !!currencyCode && currencyCode !== baseCurrency) ||
      Number(refund.exchangeRate ?? 1) !== 1 ||
      Number(refund.creditNote?.exchangeRate ?? 1) !== 1;
    return isForeign
      ? this.rewriteRefundCreditGLEntries(refundCreditNoteId, trx)
      : this.rewriteRefundCreditCashGLEntries(refundCreditNoteId, trx);
  };

  /**
   * Rewrites the refunds of the given credit note once it is edited: their
   * cash basis entries, and in a foreign currency their whole journal (the
   * credit note's rate may have changed).
   * @param {number} creditNoteId - Credit note id.
   * @param {Knex.Transaction} trx - Knex transaction.
   */
  public rewriteCreditNoteRefundsGLEntries = async (
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
      await this.rewriteRefundOnChange(refund.id, trx);
    }
  };

  /**
   * Builds the journal (accrual and cash basis) the refund is posted with.
   * @param {number} refundCreditNoteId
   * @param {Knex.Transaction} trx
   * @returns {Promise<Ledger | null>} Null when the refund is gone.
   */
  public buildRefundCreditGLedger = async (
    refundCreditNoteId: number,
    trx?: Knex.Transaction,
  ): Promise<Ledger | null> => {
    // Retrieve the refund with associated credit note and items.
    const refundCreditNote = await this.refundCreditNoteModel()
      .query(trx)
      .findById(refundCreditNoteId)
      .withGraphFetched('creditNote.entries.item');

    if (!refundCreditNote) return null;

    // The A/R account of the refund currency: the one the credit note
    // credited (the base A/R for a base currency refund).
    const receivableAccount =
      await this.accountRepository.findOrCreateAccountReceivable(
        refundCreditNote.currencyCode,
        {},
        trx,
      );
    // Retrieve refund credit ledger entries.
    return this.getRefundCreditNoteGLedger(
      refundCreditNote,
      receivableAccount.id,
      trx,
    );
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
    const ledger = await this.buildRefundCreditGLedger(refundCreditNoteId, trx);
    // Saves refund ledger entries.
    if (ledger) await this.ledgerStorage.commit(ledger, trx);
  };

  /**
   * Rewrites the whole journal of the refund (accrual and cash basis), as
   * deleting and saving it again would.
   * @param {number} refundCreditNoteId
   * @param {Knex.Transaction} trx
   */
  public rewriteRefundCreditGLEntries = async (
    refundCreditNoteId: number,
    trx?: Knex.Transaction,
  ) => {
    await this.revertRefundCreditGLEntries(refundCreditNoteId, trx);
    await this.createRefundCreditGLEntries(refundCreditNoteId, trx);
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
   * id): their running-total split starts from the refunds before them. In
   * a foreign currency their accrual entries too (the A/R relief is a
   * running total as well). Refunds in a locked period are skipped (and
   * logged).
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
      (refundId) => this.rewriteRefundOnChange(refundId, trx),
    );
  };
}
