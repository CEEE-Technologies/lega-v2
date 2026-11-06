import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { events } from '@/common/events/events';
import { runAfterTransaction } from '@/modules/Tenancy/TenancyDB/TransactionsHooks';
import { SaleEstimateSmsNotification } from '../SaleEstimateSmsNotification';
import { ISaleEstimateCreatedPayload } from '../types/SaleEstimates.types';

@Injectable()
export class SaleEstimateSmsNotificationSubscriber {
  constructor(
    private readonly saleEstimateSmsNotification: SaleEstimateSmsNotification,
  ) {}

  /**
   * Handles sending SMS notification after the sale estimate creation.
   * @param {ISaleEstimateCreatedPayload} payload -
   */
  // Side effect (SMS notice): an error is logged and does not stop the save.
  @OnEvent(events.saleEstimate.onCreated, { suppressErrors: true })
  private async handleNotifyBySmsAfterCreation({
    saleEstimateId,
    trx,
  }: ISaleEstimateCreatedPayload) {
    runAfterTransaction(trx, async () => {
      try {
        await this.saleEstimateSmsNotification.notifyDetailsBySmsAfterCreation(
          saleEstimateId,
        );
      } catch (_error) {}
    });
  }
}
