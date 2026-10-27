import { Knex } from 'knex';
import { uniq } from 'lodash';
import { Inject, Injectable } from '@nestjs/common';
import { BillPaymentGLEntries } from './BillPaymentGLEntries';
import { BillPaymentEntry } from '../models/BillPaymentEntry';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';
import { ILinkedTransaction } from '@/modules/TransactionsLocking/guards/LinkedTransactionsLockingGuard';

@Injectable()
export class BillPaymentsGLEntriesRewrite {
  constructor(
    private readonly paymentGLEntries: BillPaymentGLEntries,

    @Inject(BillPaymentEntry.name)
    private readonly billPaymentEntryModel: TenantModelProxy<
      typeof BillPaymentEntry
    >,
  ) {}

  /**
   * Retrieves the payments applied to the given bill, whose entries a bill
   * edit rewrites.
   * @param {number} billId - Bill id.
   * @param {Knex.Transaction} trx - Knex transaction.
   * @returns {Promise<ILinkedTransaction[]>}
   */
  public getBillLinkedPayments = async (
    billId: number,
    trx?: Knex.Transaction,
  ): Promise<ILinkedTransaction[]> => {
    const entries = await this.billPaymentEntryModel()
      .query(trx)
      .where('billId', billId)
      .withGraphFetched('payment');

    return entries
      .filter((entry) => entry.payment)
      .map((entry) => ({
        label: entry.payment.paymentNumber || `Payment #${entry.payment.id}`,
        date: entry.payment.paymentDate,
      }));
  };

  /**
   * Rewrites the GL entries of the payments applied to the given bill, so
   * their cash basis expense lines follow the edited bill composition.
   * @param {number} billId - Bill id.
   * @param {Knex.Transaction} trx - Knex transaction.
   * @returns {Promise<void>}
   */
  public rewriteBillPaymentsGLEntries = async (
    billId: number,
    trx?: Knex.Transaction,
  ): Promise<void> => {
    const billPaymentEntries = await this.billPaymentEntryModel()
      .query(trx)
      .where('billId', billId);

    const paymentsIds = uniq(billPaymentEntries.map((e) => e.billPaymentId));

    await this.rewritePaymentsGLEntries(paymentsIds, trx);
  };

  /**
   * Rewrites the GL entries of the given payments, one after another on the
   * same transaction.
   * @param {number[]} paymentsIds - Bill payments ids.
   * @param {Knex.Transaction} trx - Knex transaction.
   * @returns {Promise<void>}
   */
  public rewritePaymentsGLEntries = async (
    paymentsIds: number[],
    trx?: Knex.Transaction,
  ): Promise<void> => {
    for (const paymentId of paymentsIds) {
      await this.paymentGLEntries.rewritePaymentGLEntries(paymentId, trx);
    }
  };
}
