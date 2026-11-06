import { events } from '@/common/events/events';
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import {
  IPlaidItemCreatedEventPayload,
  UpdateBankingPlaidTransitionsJob,
  UpdateBankingPlaidTransitionsQueueJob,
} from '../types/BankingPlaid.types';

@Injectable()
export class PlaidUpdateTransactionsOnItemCreatedSubscriber {
  constructor(
    @InjectQueue(UpdateBankingPlaidTransitionsQueueJob)
    private readonly updateTransitionsQueue: Queue,
  ) {}

  /**
   * Updates the Plaid item transactions
   * @param {IPlaidItemCreatedEventPayload} payload - Event payload.
   */
  // Side effect (Plaid sync, after the bank connection is saved): an error is logged and does not stop the save.
  @OnEvent(events.plaid.onItemCreated, { suppressErrors: true })
  public async handleUpdateTransactionsOnItemCreated({
    plaidItemId,
  }: IPlaidItemCreatedEventPayload) {
    const payload = { plaidItemId };

    await this.updateTransitionsQueue.add(
      UpdateBankingPlaidTransitionsJob,
      payload,
      { jobId: plaidItemId },
    );
  }
}
