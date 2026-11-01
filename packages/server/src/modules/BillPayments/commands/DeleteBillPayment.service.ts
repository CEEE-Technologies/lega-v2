import { Knex } from 'knex';
import { NotFoundError } from 'objection';
import { Inject, Injectable } from '@nestjs/common';
import {
  IBillPaymentDeletingPayload,
  IBillPaymentEventDeletedPayload,
} from '../types/BillPayments.types';
import { BillPayment } from '../models/BillPayment';
import { BillPaymentEntry } from '../models/BillPaymentEntry';
import { UnitOfWork } from '../../Tenancy/TenancyDB/UnitOfWork.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { events } from '@/common/events/events';
import { TenantModelProxy } from '@/modules/System/models/TenantBaseModel';

@Injectable()
export class DeleteBillPayment {
  /**
   * @param {EventPublisher} eventPublisher - Event publisher.
   * @param {UnitOfWork} uow - Unit of work.
   * @param {typeof BillPayment} billPaymentModel - Bill payment model.
   * @param {typeof BillPaymentEntry} billPaymentEntryModel - Bill payment entry model.
   */
  constructor(
    private readonly eventEmitter: EventEmitter2,
    private readonly uow: UnitOfWork,

    @Inject(BillPayment.name)
    private readonly billPaymentModel: TenantModelProxy<typeof BillPayment>,

    @Inject(BillPaymentEntry.name)
    private readonly billPaymentEntryModel: TenantModelProxy<
      typeof BillPaymentEntry
    >,
  ) {}

  /**
   * Deletes the bill payment and associated transactions.
   * @param {Integer} billPaymentId - The given bill payment id.
   * @param {Knex.Transaction} trx - Database transaction instance.
   * @return {Promise}
   */
  public async deleteBillPayment(
    billPaymentId: number,
    trx?: Knex.Transaction,
  ) {
    // Deletes the bill transactions with associated transactions under
    // unit-of-work environment.
    return this.uow.withTransaction(async (trx: Knex.Transaction) => {
      // Retrieves the payment inside the transaction and locks its row, so
      // a second delete of the same payment waits for this one and then
      // finds it gone (instead of reverting it a second time).
      const oldBillPayment = await this.billPaymentModel()
        .query(trx)
        .withGraphFetched('entries')
        .findById(billPaymentId)
        .forUpdate()
        .throwIfNotFound();

      // Triggers `onBillPaymentDeleting` payload.
      await this.eventEmitter.emitAsync(events.billPayment.onDeleting, {
        oldBillPayment,
        trx,
      } as IBillPaymentDeletingPayload);

      // Deletes the bill payment associated entries.
      await this.billPaymentEntryModel()
        .query(trx)
        .where('bill_payment_id', billPaymentId)
        .delete();

      // Deletes the bill payment transaction.
      const deleted = await this.billPaymentModel()
        .query(trx)
        .where('id', billPaymentId)
        .delete();

      // Nothing deleted: someone else deleted it; nothing to revert.
      if (!deleted) {
        throw new NotFoundError({ modelClass: BillPayment });
      }

      // Triggers `onBillPaymentDeleted` event.
      await this.eventEmitter.emitAsync(events.billPayment.onDeleted, {
        billPaymentId,
        oldBillPayment,
        trx,
      } as IBillPaymentEventDeletedPayload);
    }, trx);
  }
}
