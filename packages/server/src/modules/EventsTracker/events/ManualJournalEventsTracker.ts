import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  IManualJournalEventCreatedPayload,
  IManualJournalEventEditedPayload,
  IManualJournalEventDeletedPayload,
} from '../../ManualJournals/types/ManualJournals.types';
import { EventTrackerService } from '../EventTracker.service';
import { events } from '@/common/events/events';
import {
  MANUAL_JOURNAL_CREATED,
  MANUAL_JOURNAL_EDITED,
  MANUAL_JOURNAL_DELETED,
} from '../event-tracker';

@Injectable()
export class ManualJournalEventsTracker {
  constructor(public readonly posthog: EventTrackerService) {}

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.manualJournals.onCreated, { suppressErrors: true })
  public handleTrackManualJournalCreatedEvent(
    _payload: IManualJournalEventCreatedPayload,
  ) {
    this.posthog.trackEvent({
      event: MANUAL_JOURNAL_CREATED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.manualJournals.onEdited, { suppressErrors: true })
  public handleTrackEditedManualJournalEvent(
    _payload: IManualJournalEventEditedPayload,
  ) {
    this.posthog.trackEvent({
      event: MANUAL_JOURNAL_EDITED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.manualJournals.onDeleted, { suppressErrors: true })
  public handleTrackDeletedManualJournalEvent(
    _payload: IManualJournalEventDeletedPayload,
  ) {
    this.posthog.trackEvent({
      event: MANUAL_JOURNAL_DELETED,
      properties: {},
    });
  }
}
