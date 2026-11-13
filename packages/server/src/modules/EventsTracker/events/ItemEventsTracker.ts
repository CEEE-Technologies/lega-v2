import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  IItemEventCreatedPayload,
  IItemEventEditedPayload,
  IItemEventDeletedPayload,
} from '@/interfaces/Item';
import { EventTrackerService } from '../EventTracker.service';
import { events } from '@/common/events/events';
import {
  ITEM_EVENT_CREATED,
  ITEM_EVENT_EDITED,
  ITEM_EVENT_DELETED,
  ITEM_EVENT_VIEWED,
} from '../event-tracker';

@Injectable()
export class ItemEventsTracker {
  constructor(public readonly posthog: EventTrackerService) {}

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.item.onCreated, { suppressErrors: true })
  public handleTrackItemCreatedEvent({}: IItemEventCreatedPayload) {
    this.posthog.trackEvent({
      event: ITEM_EVENT_CREATED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.item.onEdited, { suppressErrors: true })
  public handleTrackEditedItemEvent({}: IItemEventEditedPayload) {
    this.posthog.trackEvent({
      event: ITEM_EVENT_EDITED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.item.onDeleted, { suppressErrors: true })
  public handleTrackDeletedItemEvent({}: IItemEventDeletedPayload) {
    this.posthog.trackEvent({
      event: ITEM_EVENT_DELETED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.item.onViewed, { suppressErrors: true })
  public handleTrackViewedItemEvent({}: IItemEventDeletedPayload) {
    this.posthog.trackEvent({
      event: ITEM_EVENT_VIEWED,
      properties: {},
    });
  }
}
