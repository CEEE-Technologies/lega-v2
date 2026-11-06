import { events } from '@/common/events/events';
import { ISaleInvoiceCreatedPayload } from '@/modules/SaleInvoices/SaleInvoice.types';
import { OnEvent } from '@nestjs/event-emitter';
import { STRIPE_INTEGRAION_CONNECTED } from '../event-tracker';
import { EventTrackerService } from '../EventTracker.service';
import { Injectable } from '@nestjs/common';

@Injectable()
export class StripeIntegrationEventsTracker {
  constructor(private readonly posthog: EventTrackerService) {}

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.stripeIntegration.onOAuthCodeGranted, {
    suppressErrors: true,
  })
  public handleTrackOAuthCodeGrantedTrackEvent({}: ISaleInvoiceCreatedPayload) {
    this.posthog.trackEvent({
      event: STRIPE_INTEGRAION_CONNECTED,
      properties: {},
    });
  }
}
