import {
  BANK_TRANSACTION_MATCHED,
  BANK_TRANSACTION_EXCLUDED,
  BANK_TRANSACTION_CATEGORIZED,
  BANK_TRANSACTION_UNCATEGORIZED,
  BANK_ACCOUNT_DISCONNECTED,
} from '../event-tracker';
import { Injectable } from '@nestjs/common';
import { EventTrackerService } from '../EventTracker.service';
import { OnEvent } from '@nestjs/event-emitter';
import { events } from '@/common/events/events';
import { IBankTransactionMatchedEventPayload } from '@/modules/BankingMatching/types';
import { IBankTransactionExcludedEventPayload } from '@/modules/BankingTransactionsExclude/types/BankTransactionsExclude.types';
import {
  ICashflowTransactionCategorizedPayload,
  ICashflowTransactionUncategorizedPayload,
} from '@/modules/BankingTransactions/types/BankingTransactions.types';
import { IBankAccountDisconnectedEventPayload } from '@/modules/BankingAccounts/types/BankAccounts.types';

@Injectable()
export class BankTransactionEventsTracker {
  constructor(public readonly posthog: EventTrackerService) {}

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.bankMatch.onMatched, { suppressErrors: true })
  public handleTrackBankTransactionMatchedEvent({}: IBankTransactionMatchedEventPayload) {
    this.posthog.trackEvent({
      event: BANK_TRANSACTION_MATCHED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.bankTransactions.onExcluded, { suppressErrors: true })
  public handleTrackBankTransactionExcludedEvent({}: IBankTransactionExcludedEventPayload) {
    this.posthog.trackEvent({
      event: BANK_TRANSACTION_EXCLUDED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.cashflow.onTransactionCategorized, { suppressErrors: true })
  public handleTrackBankTransactionCategorizedEvent({}: ICashflowTransactionCategorizedPayload) {
    this.posthog.trackEvent({
      event: BANK_TRANSACTION_CATEGORIZED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.cashflow.onTransactionUncategorized, { suppressErrors: true })
  public handleTrackBankTransactionUncategorizedEvent({}: ICashflowTransactionUncategorizedPayload) {
    this.posthog.trackEvent({
      event: BANK_TRANSACTION_UNCATEGORIZED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.bankAccount.onDisconnected, { suppressErrors: true })
  public handleTrackBankAccountDisconnectedEvent({}: IBankAccountDisconnectedEventPayload) {
    this.posthog.trackEvent({
      event: BANK_ACCOUNT_DISCONNECTED,
      properties: {},
    });
  }
}
