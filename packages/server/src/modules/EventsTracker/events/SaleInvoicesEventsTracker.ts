import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ISaleInvoiceCreatedPayload,
  ISaleInvoiceEditedPayload,
} from '../../SaleInvoices/SaleInvoice.types';
import { EventTrackerService } from '../EventTracker.service';
import { events } from '@/common/events/events';
import {
  SALE_INVOICE_CREATED,
  SALE_INVOICE_DELETED,
  SALE_INVOICE_EDITED,
  SALE_INVOICE_MAIL_SENT,
  SALE_INVOICE_PDF_VIEWED,
  SALE_INVOICE_VIEWED,
} from '../event-tracker';

@Injectable()
export class SaleInvoiceEventsTracker {
  constructor(public readonly posthog: EventTrackerService) {}

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.saleInvoice.onCreated, { suppressErrors: true })
  public handleTrackInvoiceCreatedEvent({}: ISaleInvoiceCreatedPayload) {
    this.posthog.trackEvent({
      event: SALE_INVOICE_CREATED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.saleInvoice.onEdited, { suppressErrors: true })
  public handleTrackEditedInvoiceEvent({}: ISaleInvoiceEditedPayload) {
    this.posthog.trackEvent({
      event: SALE_INVOICE_EDITED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.saleInvoice.onDeleted, { suppressErrors: true })
  public handleTrackDeletedInvoiceEvent({}: ISaleInvoiceEditedPayload) {
    this.posthog.trackEvent({
      event: SALE_INVOICE_DELETED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.saleInvoice.onViewed, { suppressErrors: true })
  public handleTrackViewedInvoiceEvent({}) {
    this.posthog.trackEvent({
      event: SALE_INVOICE_VIEWED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.saleInvoice.onPdfViewed, { suppressErrors: true })
  public handleTrackPdfViewedInvoiceEvent({}) {
    this.posthog.trackEvent({
      event: SALE_INVOICE_PDF_VIEWED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.saleInvoice.onMailSent, { suppressErrors: true })
  public handleTrackMailSentInvoiceEvent({}) {
    this.posthog.trackEvent({
      event: SALE_INVOICE_MAIL_SENT,
      properties: {},
    });
  }
}
