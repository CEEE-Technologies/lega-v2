import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  IExpenseCreatedPayload,
  IExpenseEventEditPayload,
  IExpenseEventDeletePayload,
} from '../../Expenses/Expenses.types';
import { EventTrackerService } from '../EventTracker.service';
import { events } from '@/common/events/events';
import {
  EXPENSE_CREATED,
  EXPENSE_EDITED,
  EXPENSE_DELETED,
} from '../event-tracker';

@Injectable()
export class ExpenseEventsTracker {
  constructor(public readonly posthog: EventTrackerService) {}

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.expenses.onCreated, { suppressErrors: true })
  public handleTrackExpenseCreatedEvent({}: IExpenseCreatedPayload) {
    this.posthog.trackEvent({
      event: EXPENSE_CREATED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.expenses.onEdited, { suppressErrors: true })
  public handleTrackEditedExpenseEvent({}: IExpenseEventEditPayload) {
    this.posthog.trackEvent({
      event: EXPENSE_EDITED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.expenses.onDeleted, { suppressErrors: true })
  public handleTrackDeletedExpenseEvent({}: IExpenseEventDeletePayload) {
    this.posthog.trackEvent({
      event: EXPENSE_DELETED,
      properties: {},
    });
  }
}
