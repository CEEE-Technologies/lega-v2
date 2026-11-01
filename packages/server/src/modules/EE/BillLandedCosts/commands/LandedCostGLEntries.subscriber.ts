import {
  IAllocatedLandedCostCreatedPayload,
  IAllocatedLandedCostDeletedPayload,
} from '../types/BillLandedCosts.types';
import { OnEvent } from '@nestjs/event-emitter';
import { Injectable } from '@nestjs/common';
import { billLandedCostEvents } from '../BillLandedCosts.events';
import { LandedCostGLEntriesService } from './LandedCostGLEntries.service';
import { events } from '@/common/events/events';
import {
  IBillPaymentEventCreatedPayload,
  IBillPaymentEventDeletedPayload,
  IBillPaymentEventEditedPayload,
} from '@/modules/BillPayments/types/BillPayments.types';
import { IBillEditedPayload } from '@/modules/Bills/Bills.types';
import { BillPayment } from '@/modules/BillPayments/models/BillPayment';

const billsIdsOf = (...payments: Array<BillPayment | undefined>) =>
  payments
    .flatMap((payment) => payment?.entries || [])
    .map((entry) => entry.billId)
    .filter(Boolean);

@Injectable()
export class LandedCostGLEntriesSubscriber {
  constructor(
    private readonly landedCostGLEntries: LandedCostGLEntriesService,
  ) {}

  /**
   * Writes GL entries once landed cost transaction created.
   * @param {IAllocatedLandedCostCreatedPayload} payload -
   */
  @OnEvent(billLandedCostEvents.onCreated)
  async writeGLEntriesOnceLandedCostCreated({
    billLandedCost,
    trx,
  }: IAllocatedLandedCostCreatedPayload) {
    await this.landedCostGLEntries.createLandedCostGLEntries(
      billLandedCost.id,
      trx,
    );
  }

  /**
   * Reverts GL entries associated to landed cost transaction once deleted.
   * @param {IAllocatedLandedCostDeletedPayload} payload -
   */
  @OnEvent(billLandedCostEvents.onDeleted)
  async revertGLEntriesOnceLandedCostDeleted({
    oldBillLandedCost,
    trx,
  }: IAllocatedLandedCostDeletedPayload) {
    await this.landedCostGLEntries.revertLandedCostGLEntries(
      oldBillLandedCost.id,
      trx,
    );
  }

  /**
   * Rewrites the cash basis entries of the landed costs that come from the
   * paid bills once a bill payment is created, edited or deleted: on the
   * cash basis a landed cost from a bill follows its payments.
   */
  @OnEvent(events.billPayment.onCreated)
  async rewriteCashEntriesOnceBillPaymentCreated({
    billPayment,
    trx,
  }: IBillPaymentEventCreatedPayload) {
    await this.landedCostGLEntries.rewriteLandedCostsCashGLEntriesOfSourceBills(
      billsIdsOf(billPayment),
      trx,
    );
  }

  @OnEvent(events.billPayment.onEdited)
  async rewriteCashEntriesOnceBillPaymentEdited({
    billPayment,
    oldBillPayment,
    trx,
  }: IBillPaymentEventEditedPayload) {
    await this.landedCostGLEntries.rewriteLandedCostsCashGLEntriesOfSourceBills(
      billsIdsOf(billPayment, oldBillPayment),
      trx,
    );
  }

  @OnEvent(events.billPayment.onDeleted)
  async rewriteCashEntriesOnceBillPaymentDeleted({
    oldBillPayment,
    trx,
  }: IBillPaymentEventDeletedPayload) {
    await this.landedCostGLEntries.rewriteLandedCostsCashGLEntriesOfSourceBills(
      billsIdsOf(oldBillPayment),
      trx,
    );
  }

  /**
   * Rewrites the cash basis entries of the landed costs that come from the
   * edited bill: its total, so its paid share, may have changed.
   */
  @OnEvent(events.bill.onEdited)
  async rewriteCashEntriesOnceBillEdited({ bill, trx }: IBillEditedPayload) {
    await this.landedCostGLEntries.rewriteLandedCostsCashGLEntriesOfSourceBills(
      [bill.id],
      trx,
    );
  }
}
