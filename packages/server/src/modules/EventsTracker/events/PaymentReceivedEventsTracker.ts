import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  IPaymentReceivedCreatedPayload,
  IPaymentReceivedEditedPayload,
  IPaymentReceivedDeletedPayload,
} from '../../PaymentReceived/types/PaymentReceived.types';
import { EventTrackerService } from '../EventTracker.service';
import { events } from '@/common/events/events';
import {
  PAYMENT_RECEIVED_CREATED,
  PAYMENT_RECEIVED_EDITED,
  PAYMENT_RECEIVED_DELETED,
  PAYMENT_RECEIVED_PDF_VIEWED,
  PAYMENT_RECEIVED_MAIL_SENT,
} from '../event-tracker';

@Injectable()
export class PaymentReceivedEventsTracker {
  constructor(public readonly posthog: EventTrackerService) {}

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.paymentReceive.onCreated, { suppressErrors: true })
  public handleTrackPaymentReceivedCreatedEvent({}: IPaymentReceivedCreatedPayload) {
    this.posthog.trackEvent({
      event: PAYMENT_RECEIVED_CREATED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.paymentReceive.onEdited, { suppressErrors: true })
  public handleTrackEditedPaymentReceivedEvent({}: IPaymentReceivedEditedPayload) {
    this.posthog.trackEvent({
      event: PAYMENT_RECEIVED_EDITED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.paymentReceive.onDeleted, { suppressErrors: true })
  public handleTrackDeletedPaymentReceivedEvent({}: IPaymentReceivedDeletedPayload) {
    this.posthog.trackEvent({
      event: PAYMENT_RECEIVED_DELETED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.paymentReceive.onPdfViewed, { suppressErrors: true })
  public handleTrackPdfViewedPaymentReceivedEvent({}: IPaymentReceivedDeletedPayload) {
    this.posthog.trackEvent({
      event: PAYMENT_RECEIVED_PDF_VIEWED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.paymentReceive.onMailSent, { suppressErrors: true })
  public handleTrackMailSentPaymentReceivedEvent({}: IPaymentReceivedDeletedPayload) {
    this.posthog.trackEvent({
      event: PAYMENT_RECEIVED_MAIL_SENT,
      properties: {},
    });
  }
}
