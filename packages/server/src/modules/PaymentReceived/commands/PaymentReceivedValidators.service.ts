import { moneyGt, moneyLt, sumMoney, sumMoneyBy } from '@bigcapital/utils';
import { Inject, Injectable } from '@nestjs/common';
import { difference } from 'lodash';
import { Knex } from 'knex';
import { IPaymentReceivedEntryDTO } from '../types/PaymentReceived.types';
import { ERRORS } from '../constants';
import { PaymentReceived } from '../models/PaymentReceived';
import { PaymentReceivedEntry } from '../models/PaymentReceivedEntry';
import { Account } from '@/modules/Accounts/models/Account.model';
import { SaleInvoice } from '@/modules/SaleInvoices/models/SaleInvoice';
import { ServiceError } from '@/modules/Items/ServiceError';
import { ACCOUNT_TYPE } from '@/constants/accounts';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { EditPaymentReceivedDto } from '../dtos/PaymentReceived.dto';
import {
  findDuplicateDocument,
  isDocumentEntry,
  isOpeningBalanceEntry,
} from '@/modules/Contacts/ContactOpeningBalance.constants';

@Injectable()
export class PaymentReceivedValidators {
  constructor(
    @Inject(PaymentReceived.name)
    private readonly paymentReceiveModel: TenantModelProxy<
      typeof PaymentReceived
    >,

    @Inject(PaymentReceivedEntry.name)
    private readonly paymentReceiveEntryModel: TenantModelProxy<
      typeof PaymentReceivedEntry
    >,

    @Inject(SaleInvoice.name)
    private readonly saleInvoiceModel: TenantModelProxy<typeof SaleInvoice>,

    @Inject(Account.name)
    private readonly accountModel: TenantModelProxy<typeof Account>,
  ) {}

  /**
   * Validates the payment existance.
   * @param {PaymentReceive | null | undefined} payment
   */
  public validatePaymentExistance(payment: PaymentReceived | null | undefined) {
    if (!payment) {
      throw new ServiceError(ERRORS.PAYMENT_RECEIVE_NOT_EXISTS);
    }
  }

  /**
   * Validates the payment receive number existance.
   * @param {number} tenantId -
   * @param {string} paymentReceiveNo -
   */
  public async validatePaymentReceiveNoExistance(
    paymentReceiveNo: string,
    notPaymentReceiveId?: number,
  ): Promise<void> {
    const paymentReceive = await this.paymentReceiveModel()
      .query()
      .findOne('payment_receive_no', paymentReceiveNo)
      .onBuild((builder) => {
        if (notPaymentReceiveId) {
          builder.whereNot('id', notPaymentReceiveId);
        }
      });

    if (paymentReceive) {
      throw new ServiceError(ERRORS.PAYMENT_RECEIVE_NO_EXISTS);
    }
  }

  /**
   * Validates the invoices IDs existance. A payment must pay at least one
   * invoice or the customer opening balance.
   * @param {number} customerId -
   * @param {IPaymentReceivedEntryDTO[]} paymentReceiveEntries -
   * @param {Knex.Transaction} trx - Locks the invoice rows when given (FOR UPDATE).
   */
  public async validateInvoicesIDsExistance(
    customerId: number,
    paymentReceiveEntries: { invoiceId?: number | null; entryType?: string }[],
    trx?: Knex.Transaction,
  ): Promise<SaleInvoice[]> {
    const invoicesIds = paymentReceiveEntries
      .filter(isDocumentEntry)
      .map((e) => e.invoiceId)
      .filter((id): id is number => id !== undefined && id !== null);

    if (invoicesIds.length === 0) {
      // Paying only the opening balance needs no invoice.
      if (paymentReceiveEntries.some(isOpeningBalanceEntry)) {
        return [];
      }
      throw new ServiceError(ERRORS.INVOICES_IDS_NOT_FOUND);
    }

    const storedInvoicesQuery = this.saleInvoiceModel()
      .query(trx)
      .whereIn('id', invoicesIds)
      .where('customer_id', customerId);

    if (trx) {
      storedInvoicesQuery.forUpdate();
    }
    const storedInvoices = await storedInvoicesQuery;

    const storedInvoicesIds = storedInvoices.map((invoice) => invoice.id);
    const notFoundInvoicesIDs = difference(invoicesIds, storedInvoicesIds);

    if (notFoundInvoicesIDs.length > 0) {
      throw new ServiceError(ERRORS.INVOICES_IDS_NOT_FOUND);
    }
    // Filters the not delivered invoices.
    const notDeliveredInvoices = storedInvoices.filter(
      (invoice) => !invoice.isDelivered,
    );
    if (notDeliveredInvoices.length > 0) {
      throw new ServiceError(ERRORS.INVOICES_NOT_DELIVERED_YET, null, {
        notDeliveredInvoices,
      });
    }
    return storedInvoices;
  }

  /**
   * Validates that no invoice is listed more than once in the payment. Each
   * line of a payment converts and relieves its invoice from the amount paid
   * before the payment, so two lines on the same invoice would both start from
   * the same point and double count the currency rounding (EUR 0.02 at 1.5
   * paid as 0.01 + 0.01 relieved 0.04 instead of 0.03).
   * @param {{ invoiceId?: number | null; entryType?: string }[]} entries
   * @param {{ id: number }[]} storedDocuments - To name the invoice in the error.
   */
  public validateNoDuplicateInvoices(
    entries: {
      invoiceId?: number | null;
      entryType?: string;
      paymentAmount?: number;
    }[],
    storedInvoices: SaleInvoice[] = [],
  ) {
    const duplicate = findDuplicateDocument(entries, 'invoiceId');
    if (!duplicate) return;

    const invoice = storedInvoices.find((row) => row.id === duplicate.id);
    const name = invoice?.invoiceNo || `Invoice #${duplicate.id}`;
    throw new ServiceError(
      ERRORS.PAYMENT_DUPLICATE_INVOICE_ENTRIES,
      `${name} is listed twice in this payment. Combine the amounts into one line.`,
      {
        invoiceId: duplicate.id,
        invoiceNo: invoice?.invoiceNo,
        indexes: duplicate.indexes,
      },
    );
  }

  /**
   * Validates the amounts applied to invoices don't add up to more than the
   * amount received; otherwise invoices get marked paid with money that was
   * never received and the accrual and cash ledgers disagree.
   * @param {number} amount - Amount received.
   * @param {IPaymentReceivedEntryDTO[]} entries - Lines applied to invoices.
   */
  public validateEntriesWithinAmount(
    amount: number,
    entries: IPaymentReceivedEntryDTO[] = [],
  ) {
    const totalApplied = sumMoneyBy(entries, 'paymentAmount');

    // Compare in cents to ignore floating point noise.
    if (moneyGt(totalApplied, amount)) {
      throw new ServiceError(ERRORS.PAYMENT_ENTRIES_EXCEED_AMOUNT);
    }
  }

  /**
   * Validates entries invoice payment amount.
   * @param {IPaymentReceivedEntryDTO[]} paymentReceiveEntries
   * @param {IPaymentReceivedEntry[]} oldPaymentEntries
   * @param {Knex.Transaction} trx - Locks the invoice rows when given (FOR UPDATE).
   */
  public async validateInvoicesPaymentsAmount(
    paymentReceiveEntries: IPaymentReceivedEntryDTO[],
    oldPaymentEntries: PaymentReceivedEntry[] = [],
    trx?: Knex.Transaction,
  ) {
    // Opening balance lines are validated against the customer instead.
    const invoiceEntries = paymentReceiveEntries.filter(isDocumentEntry);
    const invoicesIds = invoiceEntries.map(
      (e: IPaymentReceivedEntryDTO) => e.invoiceId,
    );
    if (invoicesIds.length === 0) return;

    const storedInvoicesQuery = this.saleInvoiceModel()
      .query(trx)
      .whereIn('id', invoicesIds);

    if (trx) {
      storedInvoicesQuery.forUpdate();
    }
    const storedInvoices = await storedInvoicesQuery;

    const storedInvoicesMap = new Map(
      storedInvoices.map((invoice: SaleInvoice) => {
        // Only this invoice's line on the old payment frees up its due amount.
        const oldEntries = oldPaymentEntries.filter(
          (entry) => isDocumentEntry(entry) && entry.invoiceId === invoice.id,
        );
        const oldPaymentAmount = sumMoneyBy(oldEntries, 'paymentAmount');

        return [
          invoice.id,
          {
            ...invoice,
            dueAmount: sumMoney(invoice.dueAmount, oldPaymentAmount),
          },
        ];
      }),
    );
    const hasWrongPaymentAmount: any[] = [];

    invoiceEntries.forEach((entry: IPaymentReceivedEntryDTO, index: number) => {
      const entryInvoice = storedInvoicesMap.get(entry.invoiceId);
      const { dueAmount } = entryInvoice;

      if (moneyLt(dueAmount, entry.paymentAmount)) {
        hasWrongPaymentAmount.push({ index, due_amount: dueAmount });
      }
    });
    if (hasWrongPaymentAmount.length > 0) {
      throw new ServiceError(ERRORS.INVALID_PAYMENT_AMOUNT);
    }
  }

  /**
   * Validate the payment receive number require.
   * @param {IPaymentReceived} paymentReceiveObj
   */
  public validatePaymentReceiveNoRequire(paymentReceiveObj: PaymentReceived) {
    if (!paymentReceiveObj.paymentReceiveNo) {
      throw new ServiceError(ERRORS.PAYMENT_RECEIVE_NO_IS_REQUIRED);
    }
  }

  /**
   * Validate the payment receive entries IDs existance.
   * @param {number} paymentReceiveId
   * @param {IPaymentReceivedEntryDTO[]} paymentReceiveEntries
   */
  public async validateEntriesIdsExistance(
    paymentReceiveId: number,
    paymentReceiveEntries: IPaymentReceivedEntryDTO[],
  ) {
    const entriesIds = paymentReceiveEntries
      .filter((entry) => entry.id)
      .map((entry) => entry.id);

    const storedEntries = await this.paymentReceiveEntryModel()
      .query()
      .where('payment_receive_id', paymentReceiveId);
    const storedEntriesIds = storedEntries.map((entry: any) => entry.id);
    const notFoundEntriesIds = difference(entriesIds, storedEntriesIds);

    if (notFoundEntriesIds.length > 0) {
      throw new ServiceError(ERRORS.ENTRIES_IDS_NOT_EXISTS);
    }
  }

  /**
   * Validates the payment receive number require.
   * @param {string} paymentReceiveNo
   */
  public validatePaymentNoRequire(paymentReceiveNo: string) {
    if (!paymentReceiveNo) {
      throw new ServiceError(ERRORS.PAYMENT_RECEIVE_NO_REQUIRED);
    }
  }

  /**
   * Validate the payment customer whether modified.
   * @param {EditPaymentReceivedDto} paymentReceiveDTO
   * @param {PaymentReceived} oldPaymentReceive
   */
  public validateCustomerNotModified(
    paymentReceiveDTO: EditPaymentReceivedDto,
    oldPaymentReceive: PaymentReceived,
  ) {
    if (paymentReceiveDTO.customerId !== oldPaymentReceive.customerId) {
      throw new ServiceError(ERRORS.PAYMENT_CUSTOMER_SHOULD_NOT_UPDATE);
    }
  }

  /**
   * Validates the payment account currency code. The deposit account curreny
   * should be equals the customer currency code or the base currency.
   * @param {string} paymentAccountCurrency
   * @param {string} customerCurrency
   * @param {string} baseCurrency
   * @throws {ServiceError(ERRORS.PAYMENT_ACCOUNT_CURRENCY_INVALID)}
   */
  public validatePaymentAccountCurrency = (
    paymentAccountCurrency: string,
    customerCurrency: string,
    baseCurrency: string,
  ) => {
    if (
      paymentAccountCurrency !== customerCurrency &&
      paymentAccountCurrency !== baseCurrency
    ) {
      throw new ServiceError(ERRORS.PAYMENT_ACCOUNT_CURRENCY_INVALID);
    }
  };

  /**
   * Validates the payment receive existance.
   * @param {number} paymentReceiveId - Payment receive id.
   */
  async getPaymentReceiveOrThrowError(
    paymentReceiveId: number,
  ): Promise<PaymentReceived> {
    const paymentReceive = await this.paymentReceiveModel()
      .query()
      .withGraphFetched('entries')
      .findById(paymentReceiveId);

    if (!paymentReceive) {
      throw new ServiceError(ERRORS.PAYMENT_RECEIVE_NOT_EXISTS);
    }
    return paymentReceive;
  }

  /**
   * Validate the deposit account id existance.
   * @param {number} depositAccountId - Deposit account id.
   * @return {Promise<IAccount>}
   */
  async getDepositAccountOrThrowError(
    depositAccountId: number,
  ): Promise<Account> {
    const depositAccount = await this.accountModel()
      .query()
      .findById(depositAccountId);

    if (!depositAccount) {
      throw new ServiceError(ERRORS.DEPOSIT_ACCOUNT_NOT_FOUND);
    }
    // Detarmines whether the account is cash, bank or other current asset.
    if (
      !depositAccount.isAccountType([
        ACCOUNT_TYPE.CASH,
        ACCOUNT_TYPE.BANK,
        ACCOUNT_TYPE.OTHER_CURRENT_ASSET,
      ])
    ) {
      throw new ServiceError(ERRORS.DEPOSIT_ACCOUNT_INVALID_TYPE);
    }
    return depositAccount;
  }

  /**
   * Validate the given customer has no payments receives.
   * @param {number} customerId - Customer id.
   */
  public async validateCustomerHasNoPayments(customerId: number) {
    const paymentReceives = await this.paymentReceiveModel()
      .query()
      .where('customer_id', customerId);
    if (paymentReceives.length > 0) {
      throw new ServiceError(ERRORS.CUSTOMER_HAS_PAYMENT_RECEIVES);
    }
  }
}
