import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ICustomerEventCreatedPayload,
  ICustomerEventEditedPayload,
  ICustomerEventDeletedPayload,
} from '../../Customers/types/Customers.types';
import { EventTrackerService } from '../EventTracker.service';
import { events } from '@/common/events/events';
import {
  CUSTOMER_CREATED,
  CUSTOMER_EDITED,
  CUSTOMER_DELETED,
} from '../event-tracker';

@Injectable()
export class CustomerEventsTracker {
  constructor(public readonly posthog: EventTrackerService) {}

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.customers.onCreated, { suppressErrors: true })
  public handleTrackCustomerCreatedEvent({}: ICustomerEventCreatedPayload) {
    this.posthog.trackEvent({
      event: CUSTOMER_CREATED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.customers.onEdited, { suppressErrors: true })
  public handleTrackEditedCustomerEvent({}: ICustomerEventEditedPayload) {
    this.posthog.trackEvent({
      event: CUSTOMER_EDITED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.customers.onDeleted, { suppressErrors: true })
  public handleTrackDeletedCustomerEvent({}: ICustomerEventDeletedPayload) {
    this.posthog.trackEvent({
      event: CUSTOMER_DELETED,
      properties: {},
    });
  }
}
