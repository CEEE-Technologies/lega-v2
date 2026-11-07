import {
  getDocumentsPaidBefore,
  getLaterPayments,
  rewritePaymentsInOrder,
  VENDOR_CREDIT_REFUND_PAID_BEFORE,
} from '@/modules/AccountingBasis/CashBasisPaidBefore';
import { LedgerStorageService } from '@/modules/Ledger/LedgerStorage.service';
import { Inject, Injectable } from '@nestjs/common';
import { RefundVendorCredit } from '../models/RefundVendorCredit';
import { Ledger } from '@/modules/Ledger/Ledger';
import { Knex } from 'knex';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { Account } from '@/modules/Accounts/models/Account.model';
import { ILedgerEntry } from '@/modules/Ledger/types/Ledger.types';
import { AccountNormal } from '@/interfaces/Account';
import { AccountRepository } from '@/modules/Accounts/repositories/Account.repository';
import { AccountingBasis } from '@/common/types/AccountingBasis';
import { subtractMoney } from '@bigcapital/utils';
import { TenancyContext } from '@/modules/Tenancy/TenancyContext.service';
import {
  getExchangeGainLossEntries,
  getRunningTotalRelief,
  IRefundExchangeGainLoss,
} from '@/utils/exchange-gain-loss';
import {
  getRefundVendorCreditLocalAmount,
  RefundVendorCreditCashGL,
} from './RefundVendorCreditCashGL';

@Injectable()
export class RefundVendorCreditGLEntries {
  constructor(
    private readonly ledgerStorage: LedgerStorageService,
    private readonly accountRepository: AccountRepository,

    @Inject(Account.name)
    private readonly accountModel: TenantModelProxy<typeof Account>,

    @Inject(RefundVendorCredit.name)
    private readonly refundVendorCreditModel: TenantModelProxy<
      typeof RefundVendorCredit
    >,

    private readonly tenancyContext?: TenancyContext,
  ) {}

  /**
   * Retrieves the refund vendor credit common GL entry.
   * @param {RefundVendorCredit} refundVendorCredit
   * @returns
   */
  private getRefundVendorCreditCommonGLEntry = (
    refundVendorCredit: RefundVendorCredit,
  ) => {
    const model = refundVendorCredit as any;
    return {
      currencyCode: refundVendorCredit.currencyCode,
      exchangeRate: refundVendorCredit.exchangeRate,

      transactionType: 'RefundVendorCredit',
      transactionId: refundVendorCredit.id,
      date: refundVendorCredit.date,
      userId: refundVendorCredit.vendorCredit?.userId,

      referenceNumber: refundVendorCredit.referenceNo,

      createdAt: model.createdAt,
      indexGroup: 10,

      credit: 0,
      debit: 0,

      note: refundVendorCredit.description,
      branchId: refundVendorCredit.branchId,

      basis: AccountingBasis.Accrual,
    };
  };

  /**
   * Retrieves the refund vendor credit payable GL entry.
   * @param   {RefundVendorCredit} refundVendorCredit
   * @param   {number} APAccountId
   * @returns {ILedgerEntry}
   */
  private getRefundVendorCreditGLPayableEntry = (
    refundVendorCredit: RefundVendorCredit,
    APAccountId: number,
  ): ILedgerEntry => {
    const commonEntry =
      this.getRefundVendorCreditCommonGLEntry(refundVendorCredit);

    return {
      ...commonEntry,
      credit: getRefundVendorCreditLocalAmount(refundVendorCredit),
      foreignCredit: refundVendorCredit.amount,
      accountId: APAccountId,
      contactId: refundVendorCredit.vendorCredit.vendorId,
      index: 1,
      accountNormal: AccountNormal.CREDIT,
    };
  };

  /**
   * Retrieves the refund vendor credit deposit GL entry.
   * @param   {RefundVendorCredit} refundVendorCredit
   * @returns {ILedgerEntry}
   */
  private getRefundVendorCreditGLDepositEntry = (
    refundVendorCredit: RefundVendorCredit,
  ): ILedgerEntry => {
    const commonEntry =
      this.getRefundVendorCreditCommonGLEntry(refundVendorCredit);

    return {
      ...commonEntry,
      debit: getRefundVendorCreditLocalAmount(refundVendorCredit),
      foreignDebit: refundVendorCredit.amount,
      accountId: refundVendorCredit.depositAccountId,
      index: 2,
      accountNormal: AccountNormal.DEBIT,
    };
  };

  /**
   * Retrieves the exchange gain/loss lines of the refund. The vendor credit
   * debited A/P at its own rate; the refund relieves A/P at that rate (a
   * running total over the vendor credit's refunds), as a bill payment
   * relieves A/P at the bill rate. The A/P line is at the refund rate, so
   * this pair moves the difference from A/P to exchange gain/loss: money
   * back at a higher rate than the vendor credit's is a gain.
   * @param {RefundVendorCredit} refundVendorCredit
   * @param {number} APAccountId
   * @param {IRefundExchangeGainLoss} fx
   * @returns {ILedgerEntry[]}
   */
  private getRefundVendorCreditGLExchangeGainLossEntries = (
    refundVendorCredit: RefundVendorCredit,
    APAccountId: number,
    fx?: IRefundExchangeGainLoss,
  ): ILedgerEntry[] => {
    const vendorCredit = refundVendorCredit.vendorCredit;
    if (!fx?.exchangeGainOrLossAccountId || !vendorCredit) return [];

    const relief = getRunningTotalRelief(
      refundVendorCredit.amount,
      fx.refundedBefore,
      vendorCredit.exchangeRate ?? refundVendorCredit.exchangeRate ?? 1,
    );
    const entries = getExchangeGainLossEntries({
      commonEntry: this.getRefundVendorCreditCommonGLEntry(refundVendorCredit),
      // > 0 debits A/P: the A/P line (at the refund rate) credited more
      // than the relief.
      amount: subtractMoney(
        getRefundVendorCreditLocalAmount(refundVendorCredit),
        relief,
      ),
      baseCurrencyCode: fx.baseCurrencyCode,
      contactEntry: {
        accountId: APAccountId,
        contactId: vendorCredit.vendorId,
        index: 3,
        accountNormal: AccountNormal.CREDIT,
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
   * Retrieve refund vendor credit GL entries.
   * @param {RefundVendorCredit} refundVendorCredit
   * @param {number} APAccountId
   * @param {IRefundExchangeGainLoss} fx - Without it, no exchange gain/loss.
   * @returns {ILedgerEntry[]}
   */
  public getRefundVendorCreditGLEntries(
    refundVendorCredit: RefundVendorCredit,
    APAccountId: number,
    fx?: IRefundExchangeGainLoss,
  ): ILedgerEntry[] {
    const payableEntry = this.getRefundVendorCreditGLPayableEntry(
      refundVendorCredit,
      APAccountId,
    );
    const depositEntry =
      this.getRefundVendorCreditGLDepositEntry(refundVendorCredit);

    return [
      payableEntry,
      depositEntry,
      ...this.getRefundVendorCreditGLExchangeGainLossEntries(
        refundVendorCredit,
        APAccountId,
        fx,
      ),
    ];
  }

  /**
   * What the refunds before this one (date, then id) took of the vendor
   * credit. Locks the vendor credit in a transaction.
   * @param {RefundVendorCredit} refundVendorCredit
   * @param {Knex.Transaction} trx
   * @returns {Promise<number>}
   */
  private getRefundedBefore = async (
    refundVendorCredit: RefundVendorCredit,
    trx?: Knex.Transaction,
  ): Promise<number> => {
    const refundedBefore = await getDocumentsPaidBefore(
      trx ?? this.refundVendorCreditModel().knex(),
      VENDOR_CREDIT_REFUND_PAID_BEFORE,
      { id: refundVendorCredit.id, date: refundVendorCredit.date },
      [refundVendorCredit.vendorCreditId],
      !!trx,
    );
    return refundedBefore[refundVendorCredit.vendorCreditId] || 0;
  };

  /**
   * Retrieves what the accrual journal needs for the exchange gain/loss.
   * @param {RefundVendorCredit} refundVendorCredit
   * @param {Knex.Transaction} trx
   * @returns {Promise<IRefundExchangeGainLoss>}
   */
  private getRefundExchangeGainLoss = async (
    refundVendorCredit: RefundVendorCredit,
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
      refundedBefore: await this.getRefundedBefore(refundVendorCredit, trx),
    };
  };

  /**
   * Retrieves the refund vendor credit general ledger.
   * The ledger contains both the accrual basis entries (A/P/deposit) and the
   * cash basis entries (deposit/expense) flagged by the basis.
   * @param {RefundVendorCredit} refundVendorCredit - Refund vendor credit.
   * @param {number} APAccountId - A/P account id.
   * @param {Knex.Transaction} trx - Knex transaction.
   * @returns {Promise<Ledger>}
   */
  public getRefundVendorCreditGLedger = async (
    refundVendorCredit: RefundVendorCredit,
    APAccountId: number,
    trx?: Knex.Transaction,
  ): Promise<Ledger> => {
    // Accrual basis ledger entries.
    const accrualLedger = new Ledger(
      this.getRefundVendorCreditGLEntries(
        refundVendorCredit,
        APAccountId,
        await this.getRefundExchangeGainLoss(refundVendorCredit, trx),
      ),
    );

    // Cash basis ledger entries.
    const cashLedger = await this.getRefundVendorCreditCashLedger(
      refundVendorCredit,
      trx,
    );

    return new Ledger([
      ...accrualLedger.getEntries(),
      ...cashLedger.getEntries(),
    ]);
  };

  /**
   * Retrieves the refund vendor credit cash basis ledger.
   * @param {RefundVendorCredit} refundVendorCredit - Refund vendor credit.
   * @param {Knex.Transaction} trx - Knex transaction.
   * @returns {Promise<Ledger>}
   */
  public getRefundVendorCreditCashLedger = async (
    refundVendorCredit: RefundVendorCredit,
    trx?: Knex.Transaction,
  ): Promise<Ledger> => {
    // Find or create the purchase discount account.
    const purchaseDiscountAccount =
      await this.accountRepository.findOrCreatePurchaseDiscountAccount({}, trx);
    // Find or create the other expenses (adjustment) account.
    const otherExpensesAccount =
      await this.accountRepository.findOrCreateOtherExpensesAccount({}, trx);

    // What the earlier refunds took of the vendor credit: the running-total
    // split of this refund starts from there.
    const refundedBefore = await this.getRefundedBefore(
      refundVendorCredit,
      trx,
    );
    // A vendor credit with no expense to reverse (or a refund above what is
    // left of it) returns the refund to the vendor's prepaid expenses.
    const prepaidExpensesAccount =
      await this.accountRepository.findOrCreatePrepardExpenses({}, trx);

    const refundVendorCreditCashGL = new RefundVendorCreditCashGL(
      refundVendorCredit,
    )
      .setRefundedBefore(refundedBefore)
      .setPurchaseDiscountAccountId(purchaseDiscountAccount.id)
      .setOtherExpensesAccountId(otherExpensesAccount.id)
      .setPrepaidExpensesAccountId(prepaidExpensesAccount.id);
    return refundVendorCreditCashGL.getLedger();
  };

  /**
   * Rewrites only the cash basis entries of the given refund, e.g. once the
   * vendor credit is edited, leaving the accrual entries and balances alone.
   * @param {number} refundVendorCreditId - Refund vendor credit id.
   * @param {Knex.Transaction} trx - Knex transaction.
   */
  public rewriteRefundVendorCreditCashGLEntries = async (
    refundVendorCreditId: number,
    trx?: Knex.Transaction,
  ) => {
    await this.ledgerStorage.deleteByReference(
      refundVendorCreditId,
      'RefundVendorCredit',
      trx,
      { basis: AccountingBasis.Cash },
    );
    const refundVendorCredit = await this.refundVendorCreditModel()
      .query(trx)
      .findById(refundVendorCreditId)
      .withGraphFetched('vendorCredit.entries.item');

    if (!refundVendorCredit) return;

    const cashLedger = await this.getRefundVendorCreditCashLedger(
      refundVendorCredit,
      trx,
    );
    await this.ledgerStorage.commit(cashLedger, trx);
  };

  /**
   * Retrieves the refunds of the given vendor credit, whose cash entries a
   * vendor credit edit rewrites.
   * @param {number} vendorCreditId - Vendor credit id.
   * @param {Knex.Transaction} trx - Knex transaction.
   */
  public getVendorCreditRefunds = async (
    vendorCreditId: number,
    trx?: Knex.Transaction,
  ) => {
    const refunds = await this.refundVendorCreditModel()
      .query(trx)
      .where('vendorCreditId', vendorCreditId);

    return refunds.map((refund) => ({
      label: refund.referenceNo ? `Refund ${refund.referenceNo}` : 'A refund',
      date: refund.date,
    }));
  };

  /**
   * Rewrites a refund whose position or vendor credit changed: its cash
   * basis entries, and its accrual ones too in a foreign currency (their
   * A/P relief is a running total at the vendor credit rate, so it moves
   * with the refunds before it and with the vendor credit's rate). In the
   * base currency the accrual entries never move.
   * @param {number} refundVendorCreditId
   * @param {Knex.Transaction} trx
   */
  private rewriteRefundOnChange = async (
    refundVendorCreditId: number,
    trx?: Knex.Transaction,
  ): Promise<void> => {
    const refund = await this.refundVendorCreditModel()
      .query(trx)
      .findById(refundVendorCreditId)
      .withGraphFetched('vendorCredit');
    if (!refund) return;

    // By the currency, not the rates: a foreign document edited to the
    // rate 1 (with a refund at 1) still has to drop the exchange gain/loss
    // its accrual entries were posted with at the old rate.
    const baseCurrency = (await this.tenancyContext?.getTenantMetadata())
      ?.baseCurrency;
    const currencyCode = refund.currencyCode ?? refund.vendorCredit?.currencyCode;
    const isForeign =
      (!!baseCurrency && !!currencyCode && currencyCode !== baseCurrency) ||
      Number(refund.exchangeRate ?? 1) !== 1 ||
      Number(refund.vendorCredit?.exchangeRate ?? 1) !== 1;
    return isForeign
      ? this.rewriteRefundVendorCreditGLEntries(refundVendorCreditId, trx)
      : this.rewriteRefundVendorCreditCashGLEntries(refundVendorCreditId, trx);
  };

  /**
   * Rewrites the refunds of the given vendor credit once it is edited:
   * their cash basis entries, and in a foreign currency their whole
   * journal (the vendor credit's rate may have changed).
   * @param {number} vendorCreditId - Vendor credit id.
   * @param {Knex.Transaction} trx - Knex transaction.
   */
  public rewriteVendorCreditRefundsGLEntries = async (
    vendorCreditId: number,
    trx?: Knex.Transaction,
  ) => {
    const refunds = await this.refundVendorCreditModel()
      .query(trx)
      .where('vendorCreditId', vendorCreditId)
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
   * @param {number} refundVendorCreditId
   * @param {Knex.Transaction} trx
   * @returns {Promise<Ledger | null>} Null when the refund is gone.
   */
  public buildRefundVendorCreditGLedger = async (
    refundVendorCreditId: number,
    trx?: Knex.Transaction,
  ): Promise<Ledger | null> => {
    // Retrieve the refund with associated vendor credit and items.
    const refundVendorCredit = await this.refundVendorCreditModel()
      .query(trx)
      .findById(refundVendorCreditId)
      .withGraphFetched('vendorCredit.entries.item');

    if (!refundVendorCredit) return null;

    // Retrieve the payable account (A/P) account based on the given currency.
    const APAccount = await this.accountRepository.findOrCreateAccountsPayable(
      refundVendorCredit.currencyCode,
      {},
      trx,
    );
    // Retrieve refund vendor credit ledger entries.
    return this.getRefundVendorCreditGLedger(
      refundVendorCredit,
      APAccount.id,
      trx,
    );
  };

  /**
   * Creates refund vendor credit GL entries.
   * @param {number} refundVendorCreditId
   * @param {Knex.Transaction} trx
   */
  public createRefundVendorCreditGLEntries = async (
    refundVendorCreditId: number,
    trx?: Knex.Transaction,
  ) => {
    const ledger = await this.buildRefundVendorCreditGLedger(
      refundVendorCreditId,
      trx,
    );
    // Saves refund ledger entries.
    if (ledger) await this.ledgerStorage.commit(ledger, trx);
  };

  /**
   * Rewrites the whole journal of the refund (accrual and cash basis), as
   * deleting and saving it again would.
   * @param {number} refundVendorCreditId
   * @param {Knex.Transaction} trx
   */
  public rewriteRefundVendorCreditGLEntries = async (
    refundVendorCreditId: number,
    trx?: Knex.Transaction,
  ) => {
    await this.revertRefundVendorCreditGLEntries(refundVendorCreditId, trx);
    await this.createRefundVendorCreditGLEntries(refundVendorCreditId, trx);
  };

  /**
   * Reverts refund vendor credit GL entries.
   * @param {number} refundVendorCreditId
   * @param {Knex.Transaction} trx
   */
  public revertRefundVendorCreditGLEntries = async (
    refundVendorCreditId: number,
    trx?: Knex.Transaction,
  ) => {
    await this.ledgerStorage.deleteByReference(
      refundVendorCreditId,
      'RefundVendorCredit',
      trx,
    );
  };
  /**
   * Rebuilds, one at a time and in order, the cash basis entries of the
   * refunds of the vendor credit that come after the given position (date, then
   * id): their running-total split starts from the refunds before them. In
   * a foreign currency their accrual entries too (the A/P relief is a
   * running total as well). Refunds in a locked period are skipped (and
   * logged).
   * @param {number} vendorCreditId
   * @param {{ id: number; date: any }} after - The position to start after.
   * @param {Knex.Transaction} trx
   */
  public rewriteLaterRefundsCashGLEntries = async (
    vendorCreditId: number,
    after: { id: number; date: any },
    trx?: Knex.Transaction,
  ): Promise<void> => {
    const knex = trx ?? this.refundVendorCreditModel().knex();
    const laterRefunds = await getLaterPayments(
      knex,
      VENDOR_CREDIT_REFUND_PAID_BEFORE,
      [vendorCreditId],
      after,
    );
    await rewritePaymentsInOrder(
      knex,
      laterRefunds.filter((refund) => refund.id !== after.id),
      'RefundVendorCredit',
      (refundId) => this.rewriteRefundOnChange(refundId, trx),
    );
  };
}
