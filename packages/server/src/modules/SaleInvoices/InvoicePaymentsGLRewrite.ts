import { Knex } from 'knex';
import * as moment from 'moment';
import { sortBy, uniq } from 'lodash';
import { Inject, Injectable } from '@nestjs/common';
import { PaymentReceivedGLEntries } from '../PaymentReceived/commands/PaymentReceivedGLEntries';
import { TenantModelProxy } from '../System/models/TenantBaseModel';
import { PaymentReceivedEntry } from '../PaymentReceived/models/PaymentReceivedEntry';
import { ILinkedTransaction } from '../TransactionsLocking/guards/LinkedTransactionsLockingGuard';

@Injectable()
export class InvoicePaymentsGLEntriesRewrite {
  constructor(
    private readonly paymentGLEntries: PaymentReceivedGLEntries,

    @Inject(PaymentReceivedEntry.name)
    private readonly paymentReceivedEntryModel: TenantModelProxy<
      typeof PaymentReceivedEntry
    >,
  ) {}

  /**
   * Rewrites the payment GL entries task.
   * @param   {{ tenantId: number, paymentId: number, trx: Knex?.Transaction }}
   * @returns {Promise<void>}
   */
  public rewritePaymentsGLEntriesTask = async ({ paymentId, trx }) => {
    await this.paymentGLEntries.rewritePaymentGLEntries(paymentId, trx);
  };

  /**
   * Rewrites the payment GL entries of the given payments ids.
   * @param {number[]} paymentsIds
   * @param {Knex.Transaction} trx
   */
  public rewritePaymentsGLEntriesQueue = async (
    paymentsIds: number[],
    trx?: Knex.Transaction,
  ) => {
    // One at a time and in the given (date, then id) order: each payment's
    // cash basis split starts from what the earlier payments paid.
    for (const paymentId of paymentsIds) {
      await this.rewritePaymentsGLEntriesTask({ paymentId, trx });
    }
  };

  /**
   * Retrieves the payments applied to the given invoice, whose entries an
   * invoice edit rewrites.
   * @param {number} invoiceId
   * @param {Knex.Transaction} trx
   * @returns {Promise<ILinkedTransaction[]>}
   */
  public getInvoiceLinkedPayments = async (
    invoiceId: number,
    trx?: Knex.Transaction,
  ): Promise<ILinkedTransaction[]> => {
    const entries = await this.paymentReceivedEntryModel()
      .query(trx)
      .where('invoiceId', invoiceId)
      .withGraphFetched('payment');

    return entries
      .filter((entry) => entry.payment)
      .map((entry) => ({
        label: entry.payment.paymentReceiveNo || `Payment #${entry.payment.id}`,
        date: entry.payment.paymentDate,
      }));
  };

  /**
   * Rewrites the payments GL entries that associated to the given invoice.
   * @param {number} invoiceId
   * @param {Knex.Transaction} trx
   * @ {Promise<void>}
   */
  public invoicePaymentsGLEntriesRewrite = async (
    invoiceId: number,
    trx?: Knex.Transaction,
  ) => {
    const invoicePaymentEntries = await this.paymentReceivedEntryModel()
      .query(trx)
      .where('invoiceId', invoiceId)
      .withGraphFetched('payment');

    // The payments in date, then id order.
    const paymentsIds = uniq(
      sortBy(
        invoicePaymentEntries.filter((entry) => entry.payment),
        [
          (entry) => moment(entry.payment.paymentDate).format('YYYY-MM-DD'),
          (entry) => entry.payment.id,
        ],
      ).map((entry) => entry.paymentReceiveId),
    );

    await this.rewritePaymentsGLEntriesQueue(paymentsIds, trx);
  };
}
