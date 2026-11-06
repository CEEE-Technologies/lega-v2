import { Injectable } from '@nestjs/common';
import {
  IVendorEventCreatedPayload,
  IVendorEventEditedPayload,
  IVendorEventDeletedPayload,
} from '../../Vendors/types/Vendors.types';
import { EventTrackerService } from '../EventTracker.service';
import { events } from '@/common/events/events';
import {
  VENDOR_CREATED,
  VENDOR_EDITED,
  VENDOR_DELETED,
} from '../event-tracker';
import { OnEvent } from '@nestjs/event-emitter';

@Injectable()
export class VendorEventsTracker {
  constructor(public readonly posthog: EventTrackerService) {}

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.vendors.onCreated, { suppressErrors: true })
  public handleTrackVendorCreatedEvent({}: IVendorEventCreatedPayload) {
    this.posthog.trackEvent({
      event: VENDOR_CREATED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.vendors.onEdited, { suppressErrors: true })
  public handleTrackEditedVendorEvent({}: IVendorEventEditedPayload) {
    this.posthog.trackEvent({
      event: VENDOR_EDITED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.vendors.onDeleted, { suppressErrors: true })
  public handleTrackDeletedVendorEvent({}: IVendorEventDeletedPayload) {
    this.posthog.trackEvent({
      event: VENDOR_DELETED,
      properties: {},
    });
  }
}
