import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  IBillPaymentEventCreatedPayload,
  IBillPaymentEditingPayload,
  IBillPaymentEventDeletedPayload,
} from '../../BillPayments/types/BillPayments.types';
import { EventTrackerService } from '../EventTracker.service';
import { events } from '@/common/events/events';
import {
  PAYMENT_MADE_CREATED,
  PAYMENT_MADE_EDITED,
  PAYMENT_MADE_DELETED,
} from '../event-tracker';

@Injectable()
export class PaymentMadeEventsTracker {
  constructor(public readonly posthog: EventTrackerService) {}

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.billPayment.onCreated, { suppressErrors: true })
  public handleTrackPaymentMadeCreatedEvent({}: IBillPaymentEventCreatedPayload) {
    this.posthog.trackEvent({
      event: PAYMENT_MADE_CREATED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.billPayment.onEdited, { suppressErrors: true })
  public handleTrackEditedPaymentMadeEvent({}: IBillPaymentEditingPayload) {
    this.posthog.trackEvent({
      event: PAYMENT_MADE_EDITED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.billPayment.onDeleted, { suppressErrors: true })
  public handleTrackDeletedPaymentMadeEvent({}: IBillPaymentEventDeletedPayload) {
    this.posthog.trackEvent({
      event: PAYMENT_MADE_DELETED,
      properties: {},
    });
  }
}
