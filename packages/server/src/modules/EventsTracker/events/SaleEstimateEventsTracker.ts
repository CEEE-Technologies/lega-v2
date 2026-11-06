import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ISaleEstimateCreatedPayload,
  ISaleEstimateEditedPayload,
  ISaleEstimateDeletedPayload,
} from '../../SaleEstimates/types/SaleEstimates.types';
import { EventTrackerService } from '../EventTracker.service';
import {
  SALE_ESTIMATE_CREATED,
  SALE_ESTIMATE_EDITED,
  SALE_ESTIMATE_DELETED,
  SALE_ESTIMATE_PDF_VIEWED,
  SALE_ESTIMATE_VIEWED,
  SALE_ESTIMATE_MAIL_SENT,
} from '../event-tracker';
import { events } from '@/common/events/events';

@Injectable()
export class SaleEstimateEventsTracker {
  constructor(public readonly posthog: EventTrackerService) {}

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.saleEstimate.onCreated, { suppressErrors: true })
  public handleTrackEstimateCreatedEvent({}: ISaleEstimateCreatedPayload) {
    this.posthog.trackEvent({
      event: SALE_ESTIMATE_CREATED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.saleEstimate.onEdited, { suppressErrors: true })
  public handleTrackEditedEstimateEvent({}: ISaleEstimateEditedPayload) {
    this.posthog.trackEvent({
      event: SALE_ESTIMATE_EDITED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.saleEstimate.onDeleted, { suppressErrors: true })
  public handleTrackDeletedEstimateEvent({}: ISaleEstimateDeletedPayload) {
    this.posthog.trackEvent({
      event: SALE_ESTIMATE_DELETED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.saleEstimate.onPdfViewed, { suppressErrors: true })
  public handleTrackPdfViewedEstimateEvent({}: ISaleEstimateDeletedPayload) {
    this.posthog.trackEvent({
      event: SALE_ESTIMATE_PDF_VIEWED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.saleEstimate.onViewed, { suppressErrors: true })
  public handleTrackViewedEstimateEvent({}) {
    this.posthog.trackEvent({
      event: SALE_ESTIMATE_VIEWED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.saleEstimate.onMailSent, { suppressErrors: true })
  public handleTrackMailSentEstimateEvent({}) {
    this.posthog.trackEvent({
      event: SALE_ESTIMATE_MAIL_SENT,
      properties: {},
    });
  }
}
