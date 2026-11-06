import { Injectable } from '@nestjs/common';
import {
  IAccountEventCreatedPayload,
  IAccountEventEditedPayload,
  IAccountEventDeletedPayload,
} from '../../Accounts/Accounts.types';
import { EventTrackerService } from '../EventTracker.service';
import {
  ACCOUNT_CREATED,
  ACCOUNT_EDITED,
  ACCOUNT_DELETED,
  ACCOUNT_VIEWED,
} from '../event-tracker';
import { events } from '@/common/events/events';
import { OnEvent } from '@nestjs/event-emitter';

@Injectable()
export class AccountEventsTracker {
  constructor(public readonly posthog: EventTrackerService) {}

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.accounts.onCreated, { suppressErrors: true })
  public handleTrackAccountCreatedEvent({}: IAccountEventCreatedPayload) {
    this.posthog.trackEvent({
      event: ACCOUNT_CREATED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.accounts.onEdited, { suppressErrors: true })
  public handleTrackEditedAccountEvent({}: IAccountEventEditedPayload) {
    this.posthog.trackEvent({
      event: ACCOUNT_EDITED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.accounts.onDeleted, { suppressErrors: true })
  public handleTrackDeletedAccountEvent({}: IAccountEventDeletedPayload) {
    this.posthog.trackEvent({
      event: ACCOUNT_DELETED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.accounts.onViewed, { suppressErrors: true })
  public handleTrackAccountViewedEvent({}) {
    this.posthog.trackEvent({
      event: ACCOUNT_VIEWED,
      properties: {},
    });
  }
}
