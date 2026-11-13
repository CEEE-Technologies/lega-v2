import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  PDF_TEMPLATE_CREATED,
  PDF_TEMPLATE_EDITED,
  PDF_TEMPLATE_DELETED,
  PDF_TEMPLATE_ASSIGNED_DEFAULT,
} from '../event-tracker';
import { EventTrackerService } from '../EventTracker.service';
import { events } from '@/common/events/events';

@Injectable()
export class PdfTemplateEventsTracker {
  constructor(public readonly posthog: EventTrackerService) {}

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.pdfTemplate.onCreated, { suppressErrors: true })
  public handleTrackPdfTemplateCreatedEvent({}) {
    this.posthog.trackEvent({
      event: PDF_TEMPLATE_CREATED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.pdfTemplate.onEdited, { suppressErrors: true })
  public handleTrackEditedPdfTemplateEvent({}) {
    this.posthog.trackEvent({
      event: PDF_TEMPLATE_EDITED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.pdfTemplate.onDeleted, { suppressErrors: true })
  public handleTrackDeletedPdfTemplateEvent({}) {
    this.posthog.trackEvent({
      event: PDF_TEMPLATE_DELETED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.pdfTemplate.onAssignedDefault, { suppressErrors: true })
  public handleTrackAssignedAsDefaultPdfTemplateEvent({}) {
    this.posthog.trackEvent({
      event: PDF_TEMPLATE_ASSIGNED_DEFAULT,
      properties: {},
    });
  }
}
