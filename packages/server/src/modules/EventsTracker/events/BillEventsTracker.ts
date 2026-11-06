import { Injectable } from '@nestjs/common';
import {
  IBillPaymentEventCreatedPayload,
  IBillPaymentEventEditedPayload,
  IBillPaymentEventDeletedPayload,
} from '../../BillPayments/types/BillPayments.types';
import { EventTrackerService } from '../EventTracker.service';
import { BILL_CREATED, BILL_EDITED, BILL_DELETED } from '../event-tracker';
import { events } from '@/common/events/events';
import { OnEvent } from '@nestjs/event-emitter';

@Injectable()
export class BillEventsTracker {
  constructor(public readonly posthog: EventTrackerService) {}

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.bill.onCreated, { suppressErrors: true })
  public handleTrackBillCreatedEvent({}: IBillPaymentEventCreatedPayload) {
    this.posthog.trackEvent({
      event: BILL_CREATED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.bill.onEdited, { suppressErrors: true })
  public handleTrackEditedBillEvent({}: IBillPaymentEventEditedPayload) {
    this.posthog.trackEvent({
      event: BILL_EDITED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.bill.onDeleted, { suppressErrors: true })
  public handleTrackDeletedBillEvent({}: IBillPaymentEventDeletedPayload) {
    this.posthog.trackEvent({
      event: BILL_DELETED,
      properties: {},
    });
  }
}
