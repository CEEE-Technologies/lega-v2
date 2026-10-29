import { Knex } from 'knex';
import { PaymentReceivedAccrualGL } from './PaymentReceivedAccrualGL';
import { PaymentReceivedCashGL } from './PaymentReceivedCashGL';
import { PaymentReceivedCostGLEntries } from './PaymentReceivedCostGLEntries';
import { PaymentReceived } from '../models/PaymentReceived';
import { LedgerStorageService } from '@/modules/Ledger/LedgerStorage.service';
import { Ledger } from '@/modules/Ledger/Ledger';
import { AccountRepository } from '@/modules/Accounts/repositories/Account.repository';
import { Injectable } from '@nestjs/common';
import { Inject } from '@nestjs/common';
import { TenancyContext } from '@/modules/Tenancy/TenancyContext.service';
import { Account } from '@/modules/Accounts/models/Account.model';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { AccountingBasis } from '@/common/types/AccountingBasis';
import { ContactOpeningBalanceAccount } from '@/modules/Contacts/ContactOpeningBalanceAccount.service';
import { isDocumentEntry } from '@/modules/Contacts/ContactOpeningBalance.constants';
import {
  getDocumentsAccrualLines,
  getDocumentsPaidBefore,
  getLaterPayments,
  rewritePaymentsInOrder,
  PAYMENT_RECEIVED_PAID_BEFORE,
} from '@/modules/AccountingBasis/CashBasisPaidBefore';

@Injectable()
export class PaymentReceivedGLEntries {
  constructor(
    private readonly ledgerStorage: LedgerStorageService,
    private readonly accountRepository: AccountRepository,
    private readonly tenancyContext: TenancyContext,
    private readonly paymentReceivedCostGLEntries: PaymentReceivedCostGLEntries,
    private readonly openingBalanceAccount: ContactOpeningBalanceAccount,

    @Inject(PaymentReceived.name)
    private readonly paymentReceivedModel: TenantModelProxy<
      typeof PaymentReceived
    >,
  ) {}

  /**
   * Writes payment GL entries to the storage.
   * The written entries include the accrual basis entries (deposit/A/R),
   * the cash basis income entries and the cash basis cost entries
   * (COGS/inventory).
   * @param {number} paymentReceiveId - Payment received id.
   * @param {Knex.Transaction} trx - Knex transaction.
   * @returns {Promise<void>}
   */
  public writePaymentGLEntries = async (
    paymentReceiveId: number,
    trx?: Knex.Transaction,
  ): Promise<void> => {
    // Retrieves the given tenant metadata.
    const tenantMeta = await this.tenancyContext.getTenantMetadata();

    // Retrieves the payment receive with associated entries.
    const paymentReceive = await this.paymentReceivedModel()
      .query(trx)
      .findById(paymentReceiveId)
      .withGraphFetched('entries.invoice.entries');

    // Retrives the payment receive ledger.
    const ledger = await this.getPaymentReceiveGLedger(
      paymentReceive,
      tenantMeta.baseCurrency,
      trx,
    );
    // Commit the ledger entries to the storage.
    await this.ledgerStorage.commit(ledger, trx);
  };

  /**
   * Reverts the given payment receive GL entries.
   * @param {number} paymentReceiveId - Payment received id.
   * @param {Knex.Transaction} trx - Knex transaction.
   */
  public revertPaymentGLEntries = async (
    paymentReceiveId: number,
    trx?: Knex.Transaction,
  ) => {
    await this.ledgerStorage.deleteByReference(
      paymentReceiveId,
      'PaymentReceive',
      trx,
    );
  };

  /**
   * Rewrites the given payment receive GL entries.
   * @param {number} paymentReceiveId - Payment received id.
   * @param {Knex.Transaction} trx - Knex transaction.
   */
  public rewritePaymentGLEntries = async (
    paymentReceiveId: number,
    trx?: Knex.Transaction,
  ) => {
    // Reverts the payment GL entries.
    await this.revertPaymentGLEntries(paymentReceiveId, trx);

    // Writes the payment GL entries.
    await this.writePaymentGLEntries(paymentReceiveId, trx);
  };

  /**
   * Rewrites only the cash basis entries (income and cost) of the given
   * payment, leaving the accrual entries and the stored balances untouched.
   * Used when something the cash set depends on changes (the invoice or the
   * customer opening balance).
   * @param {number} paymentReceiveId - Payment received id.
   * @param {Knex.Transaction} trx - Knex transaction.
   */
  public rewritePaymentCashGLEntries = async (
    paymentReceiveId: number,
    trx?: Knex.Transaction,
  ): Promise<void> => {
    await this.ledgerStorage.deleteByReference(
      paymentReceiveId,
      'PaymentReceive',
      trx,
      { basis: AccountingBasis.Cash },
    );
    const paymentReceive = await this.paymentReceivedModel()
      .query(trx)
      .findById(paymentReceiveId)
      .withGraphFetched('entries.invoice.entries');

    if (!paymentReceive) return;

    const ledger = await this.getPaymentReceiveCashBasisLedger(
      paymentReceive,
      trx,
    );
    await this.ledgerStorage.commit(ledger, trx);
  };

  /**
   * Retrieves the payment receive accrual basis ledger.
   * @param {PaymentReceived} paymentReceive - Payment received.
   * @param {string} baseCurrencyCode - Base currency code.
   * @param {Knex.Transaction} trx - Knex transaction.
   * @returns {Ledger}
   */
  public getPaymentReceiveAccrualLedger = async (
    paymentReceive: PaymentReceived,
    baseCurrencyCode: string,
    trx?: Knex.Transaction,
  ): Promise<Ledger> => {
    // Retrieve the A/R account of the given currency.
    const receivableAccount =
      await this.accountRepository.findOrCreateAccountReceivable(
        paymentReceive.currencyCode,
        {},
        trx,
      );
    // Exchange gain/loss account.
    const exGainLossAccount = (await this.accountRepository.findBySlug(
      'exchange-grain-loss',
    )) as Account;

    // What the earlier payments paid on each invoice: the A/R relief at
    // the invoice rate is a running total from there.
    const paidBefore = await this.getPaymentInvoicesPaidBefore(
      paymentReceive,
      trx,
    );
    const paymentReceivedAccrualGL = new PaymentReceivedAccrualGL(
      paymentReceive,
    )
      .setPaidBefore(paidBefore)
      .setARAccountId(receivableAccount.id)
      .setExchangeGainOrLossAccountId(exGainLossAccount.id)
      .setBaseCurrencyCode(baseCurrencyCode);

    return paymentReceivedAccrualGL.getLedger();
  };

  /**
   * Retrieves the payment receive cash basis ledger.
   * @param {PaymentReceived} paymentReceive - Payment received.
   * @param {Knex.Transaction} trx - Knex transaction.
   * @returns {Ledger}
   */
  public getPaymentReceiveCashLedger = async (
    paymentReceive: PaymentReceived,
    trx?: Knex.Transaction,
    paidBefore: Record<number, number> = {},
  ): Promise<Ledger> => {
    // Find or create the tax payable account.
    const taxPayableAccount =
      await this.accountRepository.findOrCreateTaxPayable({}, trx);
    // Find or create the discount expense account.
    const discountAccount =
      await this.accountRepository.findOrCreateDiscountAccount({}, trx);
    // Find or create the other charges account.
    const otherChargesAccount =
      await this.accountRepository.findOrCreateOtherChargesAccount({}, trx);

    // Exchange gain/loss account: the currency rounding cent of a foreign
    // currency payment.
    const exGainLossAccount = (await this.accountRepository.findBySlug(
      'exchange-grain-loss',
    )) as Account;
    const paymentReceivedCashGL = new PaymentReceivedCashGL(paymentReceive)
      .setExchangeGainOrLossAccountId(exGainLossAccount?.id ?? null)
      .setAccrualLines(
        await getDocumentsAccrualLines(
          trx ?? this.paymentReceivedModel().knex(),
          'SaleInvoice',
          (paymentReceive.entries || [])
            .filter(isDocumentEntry)
            .map((entry) => entry.invoiceId),
          1,
        ),
      )
      .setTaxPayableAccountId(taxPayableAccount.id)
      .setDiscountAccountId(discountAccount.id)
      .setOtherChargesAccountId(otherChargesAccount.id)
      .setPaidBefore(paidBefore);

    // Opening balance lines post to the account the opening balance used.
    if (paymentReceivedCashGL.hasOpeningBalanceEntries()) {
      const openingBalanceAccountId =
        await this.openingBalanceAccount.getCustomerAccountId(
          paymentReceive.customerId,
          trx,
        );
      paymentReceivedCashGL.setOpeningBalanceAccountId(openingBalanceAccountId);
    }
    // The unapplied amount is unearned revenue.
    if (paymentReceivedCashGL.getExcessAmount() > 0) {
      const unearnedRevenueAccount =
        await this.accountRepository.findOrCreateUnearnedRevenue({}, trx);

      paymentReceivedCashGL.setUnearnedRevenueAccountId(
        unearnedRevenueAccount.id,
      );
    }
    return paymentReceivedCashGL.getLedger();
  };

  /**
   * Retrieves the amount paid on each invoice of the payment by the payments
   * before it (by date, then id). Locks the invoices in a transaction.
   * @param {PaymentReceived} paymentReceive - Payment received.
   * @param {Knex.Transaction} trx - Knex transaction.
   * @returns {Promise<Record<number, number>>}
   */
  public getPaymentInvoicesPaidBefore = (
    paymentReceive: PaymentReceived,
    trx?: Knex.Transaction,
  ): Promise<Record<number, number>> => {
    return getDocumentsPaidBefore(
      trx ?? this.paymentReceivedModel().knex(),
      PAYMENT_RECEIVED_PAID_BEFORE,
      { id: paymentReceive.id, date: paymentReceive.paymentDate },
      (paymentReceive.entries || [])
        .filter(isDocumentEntry)
        .map((entry) => entry.invoiceId),
      !!trx,
    );
  };

  /**
   * Retrieves the whole cash basis ledger of the payment: the income
   * entries and the cost (COGS) entries.
   * @param {PaymentReceived} paymentReceive - Payment received.
   * @param {Knex.Transaction} trx - Knex transaction.
   * @returns {Promise<Ledger>}
   */
  public getPaymentReceiveCashBasisLedger = async (
    paymentReceive: PaymentReceived,
    trx?: Knex.Transaction,
  ): Promise<Ledger> => {
    // What the earlier payments paid on each invoice: the running-total
    // split of this payment starts from there.
    const paidBefore = await this.getPaymentInvoicesPaidBefore(
      paymentReceive,
      trx,
    );
    const cashLedger = await this.getPaymentReceiveCashLedger(
      paymentReceive,
      trx,
      paidBefore,
    );
    const costLedger =
      await this.paymentReceivedCostGLEntries.getPaymentCostLedger(
        paymentReceive,
        trx,
        paidBefore,
      );
    return new Ledger([...cashLedger.getEntries(), ...costLedger.getEntries()]);
  };

  /**
   * Retrieves the payment receive general ledger.
   * The ledger contains the accrual basis entries (deposit/A/R), the cash
   * basis entries (deposit/income) and the cash basis cost entries
   * (COGS/inventory) flagged by the basis.
   * @param {PaymentReceived} paymentReceive - Payment received.
   * @param {string} baseCurrencyCode - Base currency code.
   * @param {Knex.Transaction} trx - Knex transaction.
   * @returns {Ledger}
   */
  public getPaymentReceiveGLedger = async (
    paymentReceive: PaymentReceived,
    baseCurrencyCode: string,
    trx?: Knex.Transaction,
  ): Promise<Ledger> => {
    // Accrual basis ledger entries.
    const accrualLedger = await this.getPaymentReceiveAccrualLedger(
      paymentReceive,
      baseCurrencyCode,
      trx,
    );
    // Cash basis income and cost (COGS) ledger entries.
    const cashBasisLedger = await this.getPaymentReceiveCashBasisLedger(
      paymentReceive,
      trx,
    );
    return new Ledger([
      ...accrualLedger.getEntries(),
      ...cashBasisLedger.getEntries(),
    ]);
  };
  /**
   * Rebuilds the cash basis entries of the payments of the given invoices
   * that come after the given position (date, then id), one at a time and
   * in order: their running-total split depends on the payments before
   * them. Payments in a locked period are skipped (and logged).
   * @param {number[]} invoiceIds - The invoices.
   * @param {{ id: number; date: any }} after - The position to start after.
   * @param {Knex.Transaction} trx - Knex transaction.
   */
  public rewriteLaterPaymentsCashGLEntries = async (
    invoiceIds: number[],
    after: { id: number; date: any },
    trx?: Knex.Transaction,
  ): Promise<void> => {
    const knex = trx ?? this.paymentReceivedModel().knex();
    const laterPayments = await getLaterPayments(
      knex,
      PAYMENT_RECEIVED_PAID_BEFORE,
      invoiceIds,
      after,
    );
    await rewritePaymentsInOrder(
      knex,
      laterPayments.filter((payment) => payment.id !== after.id),
      'PaymentReceive',
      (paymentId) => this.rewriteLaterPayment(paymentId, trx),
    );
  };

  /**
   * Rewrites a later payment: its cash basis entries, and its accrual ones
   * too when it pays a foreign currency invoice (their A/R relief is a
   * running total at the invoice rate, so it moves with the payments
   * before it). In the base currency the accrual entries never move.
   * @param {number} paymentReceiveId - Payment received id.
   * @param {Knex.Transaction} trx - Knex transaction.
   */
  private rewriteLaterPayment = async (
    paymentReceiveId: number,
    trx?: Knex.Transaction,
  ): Promise<void> => {
    const payment = await this.paymentReceivedModel()
      .query(trx)
      .findById(paymentReceiveId)
      .withGraphFetched('entries.invoice');
    if (!payment) return;

    const paysForeignInvoice = (payment.entries || []).some(
      (entry) => entry.invoice && Number(entry.invoice.exchangeRate ?? 1) !== 1,
    );
    return paysForeignInvoice
      ? this.rewritePaymentGLEntries(paymentReceiveId, trx)
      : this.rewritePaymentCashGLEntries(paymentReceiveId, trx);
  };
}
