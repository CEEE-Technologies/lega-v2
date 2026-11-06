import {
  IBankRuleEventCreatedPayload,
  IBankRuleEventEditedPayload,
  IBankRuleEventDeletedPayload,
} from '../../BankRules/types';
import { EventTrackerService } from '../EventTracker.service';
import { events } from '@/common/events/events';
import {
  BANK_RULE_CREATED,
  BANK_RULE_EDITED,
  BANK_RULE_DELETED,
} from '../event-tracker';
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

@Injectable()
export class BankRuleEventsTracker {
  constructor(public readonly posthog: EventTrackerService) {}

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.bankRules.onCreated, { suppressErrors: true })
  public handleTrackBankRuleCreatedEvent({}: IBankRuleEventCreatedPayload) {
    this.posthog.trackEvent({
      event: BANK_RULE_CREATED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.bankRules.onEdited, { suppressErrors: true })
  public handleTrackEditedBankRuleEvent({}: IBankRuleEventEditedPayload) {
    this.posthog.trackEvent({
      event: BANK_RULE_EDITED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.bankRules.onDeleted, { suppressErrors: true })
  public handleTrackDeletedBankRuleEvent({}: IBankRuleEventDeletedPayload) {
    this.posthog.trackEvent({
      event: BANK_RULE_DELETED,
      properties: {},
    });
  }
}
