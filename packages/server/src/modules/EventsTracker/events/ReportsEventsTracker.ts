import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  BALANCE_SHEET_VIEWED,
  TRIAL_BALANCE_SHEET_VIEWED,
  PROFIT_LOSS_SHEET_VIEWED,
  CASHFLOW_STATEMENT_VIEWED,
  GENERAL_LEDGER_VIEWED,
  JOURNAL_VIEWED,
  RECEIVABLE_AGING_VIEWED,
  PAYABLE_AGING_VIEWED,
  CUSTOMER_BALANCE_SUMMARY_VIEWED,
  VENDOR_BALANCE_SUMMARY_VIEWED,
  INVENTORY_VALUATION_VIEWED,
  CUSTOMER_TRANSACTIONS_VIEWED,
  VENDOR_TRANSACTIONS_VIEWED,
  SALES_BY_ITEM_VIEWED,
  PURCHASES_BY_ITEM_VIEWED,
} from '../event-tracker';
import { events } from '@/common/events/events';
import { EventTrackerService } from '../EventTracker.service';

@Injectable()
export class ReportsEventsTracker {
  constructor(private readonly posthog: EventTrackerService) {}

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.reports.onBalanceSheetViewed, { suppressErrors: true })
  handleTrackBalanceSheetViewedEvent() {
    this.posthog.trackEvent({
      event: BALANCE_SHEET_VIEWED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.reports.onTrialBalanceSheetView, { suppressErrors: true })
  handleTrackTrialBalanceSheetViewedEvent() {
    this.posthog.trackEvent({
      event: TRIAL_BALANCE_SHEET_VIEWED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.reports.onProfitLossSheetViewed, { suppressErrors: true })
  handleTrackProfitLossSheetViewedEvent() {
    this.posthog.trackEvent({
      event: PROFIT_LOSS_SHEET_VIEWED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.reports.onCashflowStatementViewed, { suppressErrors: true })
  handleTrackCashflowStatementViewedEvent() {
    this.posthog.trackEvent({
      event: CASHFLOW_STATEMENT_VIEWED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.reports.onGeneralLedgerViewed, { suppressErrors: true })
  handleTrackGeneralLedgerViewedEvent() {
    this.posthog.trackEvent({
      event: GENERAL_LEDGER_VIEWED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.reports.onJournalViewed, { suppressErrors: true })
  handleTrackJournalViewedEvent() {
    this.posthog.trackEvent({
      event: JOURNAL_VIEWED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.reports.onReceivableAgingViewed, { suppressErrors: true })
  handleTrackReceivableAgingViewedEvent() {
    this.posthog.trackEvent({
      event: RECEIVABLE_AGING_VIEWED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.reports.onPayableAgingViewed, { suppressErrors: true })
  handleTrackPayableAgingViewedEvent() {
    this.posthog.trackEvent({
      event: PAYABLE_AGING_VIEWED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.reports.onCustomerBalanceSummaryViewed, {
    suppressErrors: true,
  })
  handleTrackCustomerBalanceSummaryViewedEvent() {
    this.posthog.trackEvent({
      event: CUSTOMER_BALANCE_SUMMARY_VIEWED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.reports.onVendorBalanceSummaryViewed, {
    suppressErrors: true,
  })
  handleTrackVendorBalanceSummaryViewedEvent() {
    this.posthog.trackEvent({
      event: VENDOR_BALANCE_SUMMARY_VIEWED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.reports.onInventoryValuationViewed, { suppressErrors: true })
  handleTrackInventoryValuationViewedEvent() {
    this.posthog.trackEvent({
      event: INVENTORY_VALUATION_VIEWED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.reports.onCustomerTransactionsViewed, {
    suppressErrors: true,
  })
  handleTrackCustomerTransactionsViewedEvent() {
    this.posthog.trackEvent({
      event: CUSTOMER_TRANSACTIONS_VIEWED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.reports.onVendorTransactionsViewed, { suppressErrors: true })
  handleTrackVendorTransactionsViewedEvent() {
    this.posthog.trackEvent({
      event: VENDOR_TRANSACTIONS_VIEWED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.reports.onSalesByItemViewed, { suppressErrors: true })
  handleTrackSalesByItemViewedEvent() {
    this.posthog.trackEvent({
      event: SALES_BY_ITEM_VIEWED,
      properties: {},
    });
  }

  // Side effect (PostHog analytics): an error is logged and does not stop the save.
  @OnEvent(events.reports.onPurchasesByItemViewed, { suppressErrors: true })
  handleTrackPurchasesByItemViewedEvent() {
    this.posthog.trackEvent({
      event: PURCHASES_BY_ITEM_VIEWED,
      properties: {},
    });
  }
}
