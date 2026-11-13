import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { ITransactionsLockingPartialUnlocked } from '../../TransactionsLocking/types/TransactionsLocking.types';
import { EventTrackerService } from '../EventTracker.service';
import {
  TRANSACTIONS_LOCKING_LOCKED,
  TRANSACTIONS_LOCKING_LOCKING_CANCELLED,
  TRANSACTIONS_LOCKING_PARTIALLY_UNLOCK_CANCELLED,
  TRANSACTIONS_LOCKING_PARTIALLY_UNLOCKED,
} from '../event-tracker';
import { events } from '@/common/events/events';

@Injectable()
export class TransactionsLockingEventsTracker {
  constructor(public readonly posthog: EventTrackerService) {}

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.transactionsLocking.locked, { suppressErrors: true })
  public handleTransactionsLockingLockedEvent({}: ITransactionsLockingPartialUnlocked) {
    this.posthog.trackEvent({
      event: TRANSACTIONS_LOCKING_LOCKED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.transactionsLocking.lockCanceled, { suppressErrors: true })
  public handleTransactionsLockingCancelledEvent({}: ITransactionsLockingPartialUnlocked) {
    this.posthog.trackEvent({
      event: TRANSACTIONS_LOCKING_LOCKING_CANCELLED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.transactionsLocking.partialUnlocked, { suppressErrors: true })
  public handleTransactionsLockingPartiallyUnlockedEvent({}: ITransactionsLockingPartialUnlocked) {
    this.posthog.trackEvent({
      event: TRANSACTIONS_LOCKING_PARTIALLY_UNLOCKED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.transactionsLocking.partialUnlockCanceled, {
    suppressErrors: true,
  })
  public handleTransactionsLockingPartiallyUnlockCancelledEvent({}: ITransactionsLockingPartialUnlocked) {
    this.posthog.trackEvent({
      event: TRANSACTIONS_LOCKING_PARTIALLY_UNLOCK_CANCELLED,
      properties: {},
    });
  }
}
