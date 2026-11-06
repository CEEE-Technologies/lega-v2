import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { EventTrackerService } from '../EventTracker.service';
import { events } from '@/common/events/events';
import {
  PAYMENT_METHOD_EDITED,
  PAYMENT_METHOD_DELETED,
} from '../event-tracker';

@Injectable()
export class PaymentMethodEventsTracker {
  constructor(public readonly posthog: EventTrackerService) {}

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.paymentMethod.onEdited, { suppressErrors: true })
  public handleTrackPaymentMethodEditedEvent({}) {
    this.posthog.trackEvent({
      event: PAYMENT_METHOD_EDITED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.paymentMethod.onDeleted, { suppressErrors: true })
  public handleTrackPaymentMethodDeletedEvent({}) {
    this.posthog.trackEvent({
      event: PAYMENT_METHOD_DELETED,
      properties: {},
    });
  }
}
