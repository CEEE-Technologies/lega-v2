import {
  SUBSCRIPTION_CANCELLED,
  SUBSCRIPTION_PAYMENT_FAILED,
  SUBSCRIPTION_PAYMENT_SUCCEED,
  SUBSCRIPTION_PLAN_CHANGED,
  SUBSCRIPTION_RESUMED,
} from '../event-tracker';
import { OnEvent } from '@nestjs/event-emitter';
import { Injectable } from '@nestjs/common';
import { EventTrackerService } from '../EventTracker.service';
import { events } from '@/common/events/events';

@Injectable()
export class TransactionsLockingEventsTracker {
  constructor(public readonly posthog: EventTrackerService) {}

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.subscription.onSubscriptionResumed, { suppressErrors: true })
  public handleSubscriptionResumedEvent() {
    this.posthog.trackEvent({
      event: SUBSCRIPTION_RESUMED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.subscription.onSubscriptionCancelled, {
    suppressErrors: true,
  })
  public handleSubscriptionCancelledEvent() {
    this.posthog.trackEvent({
      event: SUBSCRIPTION_CANCELLED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.subscription.onSubscriptionPlanChanged, {
    suppressErrors: true,
  })
  public handleSubscriptionPlanChangedEvent() {
    this.posthog.trackEvent({
      event: SUBSCRIPTION_PLAN_CHANGED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.subscription.onSubscriptionPaymentFailed, {
    suppressErrors: true,
  })
  public handleSubscriptionPaymentFailedEvent() {
    this.posthog.trackEvent({
      event: SUBSCRIPTION_PAYMENT_FAILED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.subscription.onSubscriptionPaymentSucceed, {
    suppressErrors: true,
  })
  public handleSubscriptionPaymentSucceed() {
    this.posthog.trackEvent({
      event: SUBSCRIPTION_PAYMENT_SUCCEED,
      properties: {},
    });
  }
}
