import { events } from '@/common/events/events';
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SocketGateway } from '../../Socket/Socket.gateway';

@Injectable()
export class TriggerInvalidateCacheOnSubscriptionChange {
  constructor(private readonly socketGateway: SocketGateway) {}

  // Side effect (live-update notice): an error is logged and does not stop the save.
  @OnEvent(events.subscription.onSubscriptionCancelled, {
    suppressErrors: true,
  })
  @OnEvent(events.subscription.onSubscriptionResumed, { suppressErrors: true })
  @OnEvent(events.subscription.onSubscriptionPlanChanged, {
    suppressErrors: true,
  })
  triggerInvalidateCache() {
    // Notify the frontend to reflect the subscription changes.
    this.socketGateway.emitSubscriptionChanged();
  }
}
