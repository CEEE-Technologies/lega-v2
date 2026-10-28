import { isDocumentEntry } from '@/modules/Contacts/ContactOpeningBalance.constants';
import {
  BILL_PAYMENT_PAID_BEFORE,
  getDocumentsAccrualLines,
  getDocumentsPaidBefore,
  getLaterPayments,
  rewritePaymentsInOrder,
} from '@/modules/AccountingBasis/CashBasisPaidBefore';
import { Knex } from 'knex';
import { BillPaymentAccrualGL } from './BillPaymentAccrualGL';
import { BillPaymentCashGL } from './BillPaymentCashGL';
import { Inject, Injectable } from '@nestjs/common';
import { LedgerStorageService } from '@/modules/Ledger/LedgerStorage.service';
import { Ledger } from '@/modules/Ledger/Ledger';
import { Account } from '@/modules/Accounts/models/Account.model';
import { BillPayment } from '../models/BillPayment';
import { AccountRepository } from '@/modules/Accounts/repositories/Account.repository';
import { TenancyContext } from '@/modules/Tenancy/TenancyContext.service';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { AccountingBasis } from '@/common/types/AccountingBasis';
import { ContactOpeningBalanceAccount } from '@/modules/Contacts/ContactOpeningBalanceAccount.service';

@Injectable()
export class BillPaymentGLEntries {
  constructor(
    private readonly ledgerStorage: LedgerStorageService,
    private readonly accountRepository: AccountRepository,
    private readonly tenancyContext: TenancyContext,
    private readonly openingBalanceAccount: ContactOpeningBalanceAccount,

    @Inject(BillPayment.name)
    private readonly billPaymentModel: TenantModelProxy<typeof BillPayment>,

    @Inject(Account.name)
    private readonly accountModel: TenantModelProxy<typeof Account>,
  ) {}

  /**
   * Creates a bill payment GL entries.
   * @param {number} billPaymentId - Bill payment id.
   * @param {Knex.Transaction} trx - Knex transaction.
   */
  public writePaymentGLEntries = async (
    billPaymentId: number,
    trx?: Knex.Transaction,
  ): Promise<void> => {
    // Retrieves the bill payment details with associated entries.
    const payment = await this.billPaymentModel()
      .query(trx)
      .findById(billPaymentId)
      .withGraphFetched('entries.bill.entries.item');

    // Retrieves the given tenant metadata.
    const tenantMeta = await this.tenancyContext.getTenantMetadata();

    // Retrieves the bill payment ledger.
    const ledger = await this.getBillPaymentGLedger(
      payment,
      tenantMeta.baseCurrency,
      trx,
    );
    // Commits the ledger on the storage.
    await this.ledgerStorage.commit(ledger, trx);
  };

  /**
   * Rewrites the bill payment GL entries.
   * @param {number} tenantId
   * @param {number} billPaymentId
   * @param {Knex.Transaction} trx
   */
  public rewritePaymentGLEntries = async (
    billPaymentId: number,
    trx?: Knex.Transaction,
  ): Promise<void> => {
    // Revert payment GL entries.
    await this.revertPaymentGLEntries(billPaymentId, trx);

    // Write payment GL entries.
    await this.writePaymentGLEntries(billPaymentId, trx);
  };

  /**
   * Rewrites only the cash basis entries of the given bill payment, leaving
   * the accrual entries and the stored balances untouched. Used when
   * something the cash set depends on changes (the bill or the vendor
   * opening balance).
   * @param {number} billPaymentId - Bill payment id.
   * @param {Knex.Transaction} trx - Knex transaction.
   */
  public rewritePaymentCashGLEntries = async (
    billPaymentId: number,
    trx?: Knex.Transaction,
  ): Promise<void> => {
    await this.ledgerStorage.deleteByReference(
      billPaymentId,
      'BillPayment',
      trx,
      { basis: AccountingBasis.Cash },
    );
    const payment = await this.billPaymentModel()
      .query(trx)
      .findById(billPaymentId)
      .withGraphFetched('entries.bill.entries.item');

    if (!payment) return;

    const ledger = await this.getBillPaymentCashLedger(payment, trx);

    await this.ledgerStorage.commit(ledger, trx);
  };

  /**
   * Reverts the bill payment GL entries.
   * @param {number} tenantId
   * @param {number} billPaymentId
   * @param {Knex.Transaction} trx
   */
  public revertPaymentGLEntries = async (
    billPaymentId: number,
    trx?: Knex.Transaction,
  ): Promise<void> => {
    await this.ledgerStorage.deleteByReference(
      billPaymentId,
      'BillPayment',
      trx,
    );
  };

  /**
   * Retrieves the bill payment general ledger.
   * The ledger contains both the accrual basis entries (payment/A/P)
   * and the cash basis entries (payment/expenses) flagged by the basis.
   * @param {BillPayment} billPayment - Bill payment.
   * @param {string} baseCurrency - Base currency code.
   * @param {Knex.Transaction} trx - Knex transaction.
   * @returns {Ledger}
   */
  public getBillPaymentGLedger = async (
    billPayment: BillPayment,
    baseCurrency: string,
    trx?: Knex.Transaction,
  ): Promise<Ledger> => {
    // Finds or creates a new A/P account of the given currency.
    const APAccount = await this.accountRepository.findOrCreateAccountsPayable(
      billPayment.currencyCode,
      {},
      trx,
    );
    // Exchange gain or loss account.
    const EXGainLossAccount = await this.accountModel()
      .query(trx)
      .modify('findBySlug', 'exchange-grain-loss')
      .first();

    // What the earlier payments paid on each bill: the A/P relief at the
    // bill rate is a running total from there.
    const paidBefore = await getDocumentsPaidBefore(
      trx ?? this.billPaymentModel().knex(),
      BILL_PAYMENT_PAID_BEFORE,
      { id: billPayment.id, date: billPayment.paymentDate },
      (billPayment.entries || [])
        .filter(isDocumentEntry)
        .map((entry) => entry.billId),
      !!trx,
    );
    const billPaymentAccrualGL = new BillPaymentAccrualGL(billPayment)
      .setPaidBefore(paidBefore)
      .setAPAccountId(APAccount.id)
      .setGainLossAccountId(EXGainLossAccount.id)
      .setBaseCurrency(baseCurrency);

    // Accrual basis ledger entries.
    const accrualLedger = billPaymentAccrualGL.getBillPaymentLedger();

    // Cash basis ledger entries.
    const cashLedger = await this.getBillPaymentCashLedger(billPayment, trx);

    return new Ledger([
      ...accrualLedger.getEntries(),
      ...cashLedger.getEntries(),
    ]);
  };

  /**
   * Retrieves the bill payment cash basis ledger.
   * @param {BillPayment} billPayment - Bill payment.
   * @param {Knex.Transaction} trx - Knex transaction.
   * @returns {Promise<Ledger>}
   */
  public getBillPaymentCashLedger = async (
    billPayment: BillPayment,
    trx?: Knex.Transaction,
  ): Promise<Ledger> => {
    // Find or create tax payable account.
    const taxPayableAccount =
      await this.accountRepository.findOrCreateTaxPayable({}, trx);
    // Find or create purchase discount account.
    const purchaseDiscountAccount =
      await this.accountRepository.findOrCreatePurchaseDiscountAccount({}, trx);
    // Find or create other expenses account.
    const otherExpensesAccount =
      await this.accountRepository.findOrCreateOtherExpensesAccount({}, trx);

    // What the earlier payments paid on each bill: the running-total split
    // of this payment starts from there.
    const paidBefore = await getDocumentsPaidBefore(
      trx ?? this.billPaymentModel().knex(),
      BILL_PAYMENT_PAID_BEFORE,
      { id: billPayment.id, date: billPayment.paymentDate },
      (billPayment.entries || [])
        .filter(isDocumentEntry)
        .map((entry) => entry.billId),
      !!trx,
    );
    // Exchange gain/loss account: the currency rounding cent of a foreign
    // currency payment.
    const exGainLossAccount = await this.accountModel()
      .query(trx)
      .modify('findBySlug', 'exchange-grain-loss')
      .first();
    const billPaymentCashGL = new BillPaymentCashGL(billPayment)
      .setExchangeGainOrLossAccountId(exGainLossAccount?.id ?? null)
      .setAccrualLines(
        await getDocumentsAccrualLines(
          trx ?? this.billPaymentModel().knex(),
          'Bill',
          (billPayment.entries || [])
            .filter(isDocumentEntry)
            .map((entry) => entry.billId),
          -1,
        ),
      )
      .setPaidBefore(paidBefore)
      .setTaxPayableAccountId(taxPayableAccount.id)
      .setPurchaseDiscountAccountId(purchaseDiscountAccount.id)
      .setOtherExpensesAccountId(otherExpensesAccount.id);

    // Opening balance lines post to the account the opening balance used.
    if (billPaymentCashGL.hasOpeningBalanceEntries()) {
      const openingBalanceAccountId =
        await this.openingBalanceAccount.getVendorAccountId(
          billPayment.vendorId,
          trx,
        );
      billPaymentCashGL.setOpeningBalanceAccountId(openingBalanceAccountId);
    }
    // The unapplied amount is a prepaid expense.
    if (billPaymentCashGL.getExcessAmount() > 0) {
      const prepaidExpensesAccount =
        await this.accountRepository.findOrCreatePrepardExpenses({}, trx);

      billPaymentCashGL.setPrepaidExpensesAccountId(prepaidExpensesAccount.id);
    }
    return billPaymentCashGL.getLedger();
  };
  /**
   * Rebuilds the cash basis entries of the payments of the given bills
   * that come after the given position (date, then id), one at a time and
   * in order: their running-total split depends on the payments before
   * them. Payments in a locked period are skipped (and logged).
   * @param {number[]} billIds - The bills.
   * @param {{ id: number; date: any }} after - The position to start after.
   * @param {Knex.Transaction} trx - Knex transaction.
   */
  public rewriteLaterPaymentsCashGLEntries = async (
    billIds: number[],
    after: { id: number; date: any },
    trx?: Knex.Transaction,
  ): Promise<void> => {
    const knex = trx ?? this.billPaymentModel().knex();
    const laterPayments = await getLaterPayments(
      knex,
      BILL_PAYMENT_PAID_BEFORE,
      billIds,
      after,
    );
    await rewritePaymentsInOrder(
      knex,
      laterPayments.filter((payment) => payment.id !== after.id),
      'BillPayment',
      (paymentId) => this.rewriteLaterPayment(paymentId, trx),
    );
  };

  /**
   * Rewrites a later payment: its cash basis entries, and its accrual ones
   * too when it pays a foreign currency bill (their A/P relief is a
   * running total at the bill rate, so it moves with the payments before
   * it). In the base currency the accrual entries never move.
   * @param {number} billPaymentId - Bill payment id.
   * @param {Knex.Transaction} trx - Knex transaction.
   */
  private rewriteLaterPayment = async (
    billPaymentId: number,
    trx?: Knex.Transaction,
  ): Promise<void> => {
    const payment = await this.billPaymentModel()
      .query(trx)
      .findById(billPaymentId)
      .withGraphFetched('entries.bill');
    if (!payment) return;

    const paysForeignBill = (payment.entries || []).some(
      (entry) => entry.bill && Number(entry.bill.exchangeRate ?? 1) !== 1,
    );
    return paysForeignBill
      ? this.rewritePaymentGLEntries(billPaymentId, trx)
      : this.rewritePaymentCashGLEntries(billPaymentId, trx);
  };
}
