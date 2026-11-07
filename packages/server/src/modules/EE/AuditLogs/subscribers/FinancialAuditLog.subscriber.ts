import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Knex } from 'knex';
import { events } from '@/common/events/events';
import { AbilitySubject } from '@/modules/Roles/Roles.types';
import { AuditLogService } from '../AuditLog.service';
import {
  IBillCreatedPayload,
  IBillEditedPayload,
  IBIllEventDeletedPayload,
  IBillOpenedPayload,
} from '@/modules/Bills/Bills.types';
import {
  ISaleInvoiceCreatedPayload,
  ISaleInvoiceEditedPayload,
  ISaleInvoiceDeletedPayload,
  ISaleInvoiceEventDeliveredPayload,
  ISaleInvoiceWrittenOffCanceledPayload,
  ISaleInvoiceWriteoffCreatePayload,
} from '@/modules/SaleInvoices/SaleInvoice.types';
import {
  ISaleReceiptCreatedPayload,
  ISaleReceiptEditedPayload,
  ISaleReceiptEventDeletedPayload,
} from '@/modules/SaleReceipts/types/SaleReceipts.types';
import {
  IPaymentReceivedCreatedPayload,
  IPaymentReceivedEditedPayload,
  IPaymentReceivedDeletedPayload,
} from '@/modules/PaymentReceived/types/PaymentReceived.types';
import {
  IBillPaymentEventCreatedPayload,
  IBillPaymentEventEditedPayload,
  IBillPaymentEventDeletedPayload,
} from '@/modules/BillPayments/types/BillPayments.types';
import {
  IExpenseCreatedPayload,
  IExpenseEventEditPayload,
  IExpenseEventDeletePayload,
  IExpenseEventPublishedPayload,
} from '@/modules/Expenses/Expenses.types';
import {
  ICreditNoteCreatedPayload,
  ICreditNoteEditedPayload,
  ICreditNoteDeletedPayload,
  ICreditNoteOpenedPayload,
} from '@/modules/CreditNotes/types/CreditNotes.types';
import {
  IVendorCreditCreatedPayload,
  IVendorCreditEditedPayload,
  IVendorCreditDeletedPayload,
  IVendorCreditOpenedPayload,
} from '@/modules/VendorCredit/types/VendorCredit.types';
import {
  IManualJournalEventCreatedPayload,
  IManualJournalEventEditedPayload,
  IManualJournalEventDeletedPayload,
  IManualJournalEventPublishedPayload,
} from '@/modules/ManualJournals/types/ManualJournals.types';
import {
  ICommandCashflowCreatedPayload,
  ICommandCashflowDeletedPayload,
  ICashflowTransactionCategorizedPayload,
} from '@/modules/BankingTransactions/types/BankingTransactions.types';
import {
  IAccountEventCreatedPayload,
  IAccountEventDeletedPayload,
  IAccountEventActivatedPayload,
} from '@/interfaces/Account';
import {
  IInventoryAdjustmentEventCreatedPayload,
  IInventoryAdjustmentEventPublishedPayload,
  IInventoryAdjustmentEventDeletedPayload,
} from '@/modules/InventoryAdjutments/types/InventoryAdjustments.types';
import {
  IWarehouseTransferCreated,
  IWarehouseTransferEditedPayload,
  IWarehouseTransferDeletedPayload,
  IWarehouseTransferInitiatedPayload,
  IWarehouseTransferTransferredPayload,
} from '@/modules/Warehouses/Warehouse.types';
import {
  ITransactionsLockingPartialUnlocked,
  ITransactionsLockingCanceled,
} from '@/modules/TransactionsLocking/types/TransactionsLocking.types';
import {
  ISaleEstimateCreatedPayload,
  ISaleEstimateEditedPayload,
  ISaleEstimateDeletedPayload,
} from '@/modules/SaleEstimates/types/SaleEstimates.types';
import { IRefundCreditNoteCreatedPayload } from '@/modules/CreditNoteRefunds/types/CreditNoteRefunds.types';
import { IRefundVendorCreditCreatedPayload } from '@/modules/VendorCreditsRefund/types/VendorCreditRefund.types';
import {
  IItemEventCreatedPayload,
  IItemEventEditedPayload,
  IItemEventDeletedPayload,
  IItemEventActivatedPayload,
  IItemEventInactivatedPayload,
} from '@/interfaces/Item';
import {
  ICustomerEventCreatedPayload,
  ICustomerEventEditedPayload,
  ICustomerEventDeletedPayload,
} from '@/modules/Customers/types/Customers.types';
import {
  IVendorEventCreatedPayload,
  IVendorEventEditedPayload,
  IVendorEventDeletedPayload,
} from '@/modules/Vendors/types/Vendors.types';
import {
  IRoleCreatedPayload,
  IRoleEditedPayload,
  IRoleDeletedPayload,
} from '@/modules/Roles/Roles.types';
import {
  ITaxRateCreatedPayload,
  ITaxRateEditedPayload,
  ITaxRateDeletedPayload,
  ITaxRateActivatedPayload,
} from '@/modules/TaxRates/TaxRates.types';
import {
  IWarehouseCreatedPayload,
  IWarehouseEditedPayload,
  IWarehouseDeletedPayload,
} from '@/modules/Warehouses/Warehouse.types';
import {
  IBranchesActivatedPayload,
  IBranchMarkedAsPrimaryPayload,
} from '@/modules/Branches/Branches.types';
import {
  IItemCategoryCreatedPayload,
  IItemCategoryEditedPayload,
  IItemCategoryDeletedPayload,
} from '@/modules/ItemCategories/ItemCategory.interfaces';
import {
  IBankRuleEventCreatedPayload,
  IBankRuleEventEditedPayload,
  IBankRuleEventDeletedPayload,
} from '@/modules/BankRules/types';
import { IUncategorizedTransactionCreatedEventPayload } from '@/modules/BankingCategorize/types/BankingCategorize.types';
import {
  IPlaidItemCreatedEventPayload,
  IPlaidTransactionsSyncedEventPayload,
  IPlaidWebhookReceivedEventPayload,
} from '@/modules/BankingPlaid/types/BankingPlaid.types';
import {
  IBankTransactionExcludedEventPayload,
  IBankTransactionUnexcludedEventPayload,
} from '@/modules/BankingTransactionsExclude/types/BankTransactionsExclude.types';
import { IBankAccountDisconnectedEventPayload } from '@/modules/BankingAccounts/types/BankAccounts.types';
import {
  IBankTransactionMatchedEventPayload,
  IBankTransactionUnmatchedEventPayload,
} from '@/modules/BankingMatching/types';
import { IPendingTransactionRemovedEventPayload } from '@/modules/BankingTransactions/types/BankingTransactions.types';
import {
  IBankTransactionRecognizedEventPayload,
  IBankTransactionRevertedEventPayload,
} from '@/modules/BankingTranasctionsRegonize/_types';

@Injectable()
export class FinancialAuditLogSubscriber {
  constructor(private readonly auditLog: AuditLogService) {}

  private async write(
    trx: Knex.Transaction | undefined,
    action: string,
    subject: string,
    subjectId: number | null,
    metadata: Record<string, unknown>,
  ) {
    await this.auditLog.record({ trx, action, subject, subjectId, metadata });
  }

  // --- Bills ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.bill.onCreated, { suppressErrors: true })
  async onBillCreated({ bill, trx }: IBillCreatedPayload) {
    await this.write(trx, 'created', AbilitySubject.Bill, bill.id, {
      billNumber: bill.billNumber,
      amount: bill.amount,
      currencyCode: bill.currencyCode,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.bill.onEdited, { suppressErrors: true })
  async onBillEdited({ bill, trx }: IBillEditedPayload) {
    await this.write(trx, 'edited', AbilitySubject.Bill, bill.id, {
      billNumber: bill.billNumber,
      amount: bill.amount,
      currencyCode: bill.currencyCode,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.bill.onDeleted, { suppressErrors: true })
  async onBillDeleted({ billId, oldBill, trx }: IBIllEventDeletedPayload) {
    await this.write(trx, 'deleted', AbilitySubject.Bill, billId, {
      billNumber: oldBill.billNumber,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.bill.onOpened, { suppressErrors: true })
  async onBillOpened({ bill, trx }: IBillOpenedPayload) {
    await this.write(trx, 'opened', AbilitySubject.Bill, bill.id, {
      billNumber: bill.billNumber,
    });
  }

  // --- Sale invoices ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.saleInvoice.onCreated, { suppressErrors: true })
  async onSaleInvoiceCreated({ saleInvoice, trx }: ISaleInvoiceCreatedPayload) {
    await this.write(
      trx,
      'created',
      AbilitySubject.SaleInvoice,
      saleInvoice.id,
      {
        invoiceNumber: saleInvoice.invoiceNo,
        balance: saleInvoice.balance,
        currencyCode: saleInvoice.currencyCode,
      },
    );
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.saleInvoice.onEdited, { suppressErrors: true })
  async onSaleInvoiceEdited({ saleInvoice, trx }: ISaleInvoiceEditedPayload) {
    await this.write(
      trx,
      'edited',
      AbilitySubject.SaleInvoice,
      saleInvoice.id,
      {
        invoiceNumber: saleInvoice.invoiceNo,
        balance: saleInvoice.balance,
        currencyCode: saleInvoice.currencyCode,
      },
    );
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.saleInvoice.onDeleted, { suppressErrors: true })
  async onSaleInvoiceDeleted({
    saleInvoiceId,
    oldSaleInvoice,
    trx,
  }: ISaleInvoiceDeletedPayload) {
    await this.write(
      trx,
      'deleted',
      AbilitySubject.SaleInvoice,
      saleInvoiceId,
      { invoiceNumber: oldSaleInvoice.invoiceNo },
    );
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.saleInvoice.onDelivered, { suppressErrors: true })
  async onSaleInvoiceDelivered({
    saleInvoice,
    trx,
  }: ISaleInvoiceEventDeliveredPayload) {
    await this.write(
      trx,
      'delivered',
      AbilitySubject.SaleInvoice,
      saleInvoice.id,
      {
        invoiceNumber: saleInvoice.invoiceNo,
      },
    );
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.saleInvoice.onWrittenoff, { suppressErrors: true })
  async onSaleInvoiceWrittenoff({
    saleInvoice,
    trx,
  }: ISaleInvoiceWriteoffCreatePayload) {
    await this.write(
      trx,
      'writtenoff',
      AbilitySubject.SaleInvoice,
      saleInvoice.id,
      {
        invoiceNumber: saleInvoice.invoiceNo,
      },
    );
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.saleInvoice.onWrittenoffCanceled, { suppressErrors: true })
  async onSaleInvoiceWrittenoffCanceled({
    saleInvoice,
    trx,
  }: ISaleInvoiceWrittenOffCanceledPayload) {
    await this.write(
      trx,
      'writtenoff_canceled',
      AbilitySubject.SaleInvoice,
      saleInvoice.id,
      { invoiceNumber: saleInvoice.invoiceNo },
    );
  }

  // --- Sale receipts ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.saleReceipt.onCreated, { suppressErrors: true })
  async onSaleReceiptCreated({ saleReceipt, trx }: ISaleReceiptCreatedPayload) {
    await this.write(
      trx,
      'created',
      AbilitySubject.SaleReceipt,
      saleReceipt.id,
      {
        receiptNumber: saleReceipt.receiptNumber,
        amount: saleReceipt.total,
        currencyCode: saleReceipt.currencyCode,
      },
    );
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.saleReceipt.onEdited, { suppressErrors: true })
  async onSaleReceiptEdited({ saleReceipt, trx }: ISaleReceiptEditedPayload) {
    await this.write(
      trx,
      'edited',
      AbilitySubject.SaleReceipt,
      saleReceipt.id,
      {
        receiptNumber: saleReceipt.receiptNumber,
        amount: saleReceipt.total,
        currencyCode: saleReceipt.currencyCode,
      },
    );
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.saleReceipt.onDeleted, { suppressErrors: true })
  async onSaleReceiptDeleted({
    saleReceiptId,
    oldSaleReceipt,
    trx,
  }: ISaleReceiptEventDeletedPayload) {
    await this.write(
      trx,
      'deleted',
      AbilitySubject.SaleReceipt,
      saleReceiptId,
      { receiptNumber: oldSaleReceipt.receiptNumber },
    );
  }

  // --- Payments received ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.paymentReceive.onCreated, { suppressErrors: true })
  async onPaymentReceivedCreated({
    paymentReceive,
    trx,
  }: IPaymentReceivedCreatedPayload) {
    await this.write(
      trx,
      'created',
      AbilitySubject.PaymentReceive,
      paymentReceive.id,
      {
        paymentReceiveNo: paymentReceive.paymentReceiveNo,
        amount: paymentReceive.amount,
        currencyCode: paymentReceive.currencyCode,
      },
    );
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.paymentReceive.onEdited, { suppressErrors: true })
  async onPaymentReceivedEdited({
    paymentReceive,
    trx,
  }: IPaymentReceivedEditedPayload) {
    await this.write(
      trx,
      'edited',
      AbilitySubject.PaymentReceive,
      paymentReceive.id,
      {
        paymentReceiveNo: paymentReceive.paymentReceiveNo,
        amount: paymentReceive.amount,
      },
    );
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.paymentReceive.onDeleted, { suppressErrors: true })
  async onPaymentReceivedDeleted({
    paymentReceiveId,
    oldPaymentReceive,
    trx,
  }: IPaymentReceivedDeletedPayload) {
    await this.write(
      trx,
      'deleted',
      AbilitySubject.PaymentReceive,
      paymentReceiveId,
      { paymentReceiveNo: oldPaymentReceive.paymentReceiveNo },
    );
  }

  // --- Bill payments (payments made) ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.billPayment.onCreated, { suppressErrors: true })
  async onBillPaymentCreated({
    billPayment,
    trx,
  }: IBillPaymentEventCreatedPayload) {
    await this.write(
      trx,
      'created',
      AbilitySubject.PaymentMade,
      billPayment.id,
      {
        paymentNumber: billPayment.paymentNumber,
        amount: billPayment.amount,
        currencyCode: billPayment.currencyCode,
      },
    );
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.billPayment.onEdited, { suppressErrors: true })
  async onBillPaymentEdited({
    billPayment,
    trx,
  }: IBillPaymentEventEditedPayload) {
    await this.write(
      trx,
      'edited',
      AbilitySubject.PaymentMade,
      billPayment.id,
      {
        paymentNumber: billPayment.paymentNumber,
        amount: billPayment.amount,
      },
    );
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.billPayment.onDeleted, { suppressErrors: true })
  async onBillPaymentDeleted({
    billPaymentId,
    oldBillPayment,
    trx,
  }: IBillPaymentEventDeletedPayload) {
    await this.write(
      trx,
      'deleted',
      AbilitySubject.PaymentMade,
      billPaymentId,
      { paymentNumber: oldBillPayment.paymentNumber },
    );
  }

  // --- Expenses ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.expenses.onCreated, { suppressErrors: true })
  async onExpenseCreated({ expense, expenseId, trx }: IExpenseCreatedPayload) {
    await this.write(trx, 'created', AbilitySubject.Expense, expenseId, {
      amount: expense.totalAmount,
      currencyCode: expense.currencyCode,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.expenses.onEdited, { suppressErrors: true })
  async onExpenseEdited({ expense, expenseId, trx }: IExpenseEventEditPayload) {
    await this.write(trx, 'edited', AbilitySubject.Expense, expenseId, {
      amount: expense.totalAmount,
      currencyCode: expense.currencyCode,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.expenses.onDeleted, { suppressErrors: true })
  async onExpenseDeleted({
    expenseId,
    oldExpense,
    trx,
  }: IExpenseEventDeletePayload) {
    await this.write(trx, 'deleted', AbilitySubject.Expense, expenseId, {
      amount: oldExpense.totalAmount,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.expenses.onPublished, { suppressErrors: true })
  async onExpensePublished({
    expense,
    expenseId,
    trx,
  }: IExpenseEventPublishedPayload) {
    await this.write(trx, 'published', AbilitySubject.Expense, expenseId, {
      amount: expense.totalAmount,
      currencyCode: expense.currencyCode,
    });
  }

  // --- Credit notes ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.creditNote.onCreated, { suppressErrors: true })
  async onCreditNoteCreated({ creditNote, trx }: ICreditNoteCreatedPayload) {
    await this.write(trx, 'created', AbilitySubject.CreditNote, creditNote.id, {
      creditNoteNumber: creditNote.creditNoteNumber,
      amount: creditNote.total,
      currencyCode: creditNote.currencyCode,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.creditNote.onEdited, { suppressErrors: true })
  async onCreditNoteEdited({ creditNote, trx }: ICreditNoteEditedPayload) {
    await this.write(trx, 'edited', AbilitySubject.CreditNote, creditNote.id, {
      creditNoteNumber: creditNote.creditNoteNumber,
      amount: creditNote.total,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.creditNote.onDeleted, { suppressErrors: true })
  async onCreditNoteDeleted({
    creditNoteId,
    oldCreditNote,
    trx,
  }: ICreditNoteDeletedPayload) {
    await this.write(trx, 'deleted', AbilitySubject.CreditNote, creditNoteId, {
      creditNoteNumber: oldCreditNote.creditNoteNumber,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.creditNote.onOpened, { suppressErrors: true })
  async onCreditNoteOpened({ creditNote, trx }: ICreditNoteOpenedPayload) {
    await this.write(trx, 'opened', AbilitySubject.CreditNote, creditNote.id, {
      creditNoteNumber: creditNote.creditNoteNumber,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.creditNote.onRefundCreated, { suppressErrors: true })
  async onCreditNoteRefundCreated({
    trx,
    refundCreditNote,
    creditNote,
  }: IRefundCreditNoteCreatedPayload) {
    await this.write(
      trx,
      'refund_created',
      'CreditNoteRefund',
      refundCreditNote.id,
      {
        creditNoteId: creditNote.id,
        amount: refundCreditNote.amount,
      },
    );
  }

  // --- Vendor credits ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.vendorCredit.onCreated, { suppressErrors: true })
  async onVendorCreditCreated({
    vendorCredit,
    trx,
  }: IVendorCreditCreatedPayload) {
    await this.write(
      trx,
      'created',
      AbilitySubject.VendorCredit,
      vendorCredit.id,
      {
        vendorCreditNumber: vendorCredit.vendorCreditNumber,
        total: vendorCredit.total,
        currencyCode: vendorCredit.currencyCode,
      },
    );
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.vendorCredit.onEdited, { suppressErrors: true })
  async onVendorCreditEdited({
    vendorCredit,
    trx,
  }: IVendorCreditEditedPayload) {
    await this.write(
      trx,
      'edited',
      AbilitySubject.VendorCredit,
      vendorCredit.id,
      {
        vendorCreditNumber: vendorCredit.vendorCreditNumber,
        total: vendorCredit.total,
      },
    );
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.vendorCredit.onDeleted, { suppressErrors: true })
  async onVendorCreditDeleted({
    vendorCreditId,
    oldVendorCredit,
    trx,
  }: IVendorCreditDeletedPayload) {
    await this.write(
      trx,
      'deleted',
      AbilitySubject.VendorCredit,
      vendorCreditId,
      { vendorCreditNumber: oldVendorCredit.vendorCreditNumber },
    );
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.vendorCredit.onOpened, { suppressErrors: true })
  async onVendorCreditOpened({
    vendorCredit,
    vendorCreditId,
    trx,
  }: IVendorCreditOpenedPayload) {
    await this.write(
      trx,
      'opened',
      AbilitySubject.VendorCredit,
      vendorCreditId,
      {
        vendorCreditNumber: vendorCredit.vendorCreditNumber,
      },
    );
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.vendorCredit.onRefundCreated, { suppressErrors: true })
  async onVendorCreditRefundCreated({
    trx,
    refundVendorCredit,
    vendorCredit,
  }: IRefundVendorCreditCreatedPayload) {
    await this.write(
      trx,
      'refund_created',
      'VendorCreditRefund',
      refundVendorCredit.id,
      { vendorCreditId: vendorCredit.id, amount: refundVendorCredit.amount },
    );
  }

  // --- Manual journals ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.manualJournals.onCreated, { suppressErrors: true })
  async onManualJournalCreated({
    manualJournal,
    trx,
  }: IManualJournalEventCreatedPayload) {
    await this.write(
      trx,
      'created',
      AbilitySubject.ManualJournal,
      manualJournal.id,
      {
        journalNumber: manualJournal.journalNumber,
        amount: manualJournal.amount,
        currencyCode: manualJournal.currencyCode,
      },
    );
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.manualJournals.onEdited, { suppressErrors: true })
  async onManualJournalEdited({
    manualJournal,
    trx,
  }: IManualJournalEventEditedPayload) {
    await this.write(
      trx,
      'edited',
      AbilitySubject.ManualJournal,
      manualJournal.id,
      {
        journalNumber: manualJournal.journalNumber,
        amount: manualJournal.amount,
      },
    );
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.manualJournals.onDeleted, { suppressErrors: true })
  async onManualJournalDeleted({
    manualJournalId,
    trx,
  }: IManualJournalEventDeletedPayload) {
    await this.write(
      trx,
      'deleted',
      AbilitySubject.ManualJournal,
      manualJournalId,
      {},
    );
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.manualJournals.onPublished, { suppressErrors: true })
  async onManualJournalPublished({
    manualJournal,
    trx,
  }: IManualJournalEventPublishedPayload) {
    await this.write(
      trx,
      'published',
      AbilitySubject.ManualJournal,
      manualJournal.id,
      { journalNumber: manualJournal.journalNumber },
    );
  }

  // --- Cashflow ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.cashflow.onTransactionCreated, { suppressErrors: true })
  async onCashflowCreated({
    cashflowTransaction,
    trx,
  }: ICommandCashflowCreatedPayload) {
    await this.write(
      trx,
      'created',
      AbilitySubject.Cashflow,
      cashflowTransaction.id,
      {
        amount: cashflowTransaction.amount,
        currencyCode: cashflowTransaction.currencyCode,
      },
    );
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.cashflow.onTransactionDeleted, { suppressErrors: true })
  async onCashflowDeleted({
    cashflowTransactionId,
    trx,
  }: ICommandCashflowDeletedPayload) {
    await this.write(
      trx,
      'deleted',
      AbilitySubject.Cashflow,
      cashflowTransactionId,
      {},
    );
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.cashflow.onTransactionCategorized, { suppressErrors: true })
  async onCashflowCategorized({
    cashflowTransaction,
    trx,
  }: ICashflowTransactionCategorizedPayload) {
    await this.write(
      trx,
      'categorized',
      AbilitySubject.Cashflow,
      cashflowTransaction.id,
      { amount: cashflowTransaction.amount },
    );
  }

  // --- GL accounts ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.accounts.onCreated, { suppressErrors: true })
  async onAccountCreated({
    account,
    accountId,
    trx,
  }: IAccountEventCreatedPayload) {
    await this.write(trx, 'created', AbilitySubject.Account, accountId, {
      name: account.name,
      code: account.code,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.accounts.onDeleted, { suppressErrors: true })
  async onAccountDeleted({
    accountId,
    oldAccount,
    trx,
  }: IAccountEventDeletedPayload) {
    await this.write(trx, 'deleted', AbilitySubject.Account, accountId, {
      name: oldAccount.name,
      code: oldAccount.code,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.accounts.onActivated, { suppressErrors: true })
  async onAccountActivated({
    accountId,
    activate,
    account,
    trx,
  }: IAccountEventActivatedPayload) {
    await this.write(
      trx,
      activate ? 'activated' : 'inactivated',
      AbilitySubject.Account,
      accountId,
      {
        name: account.name,
        code: account.code,
      },
    );
  }

  // --- Contacts (Customers/Vendors) ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.contacts.onActivated, { suppressErrors: true })
  async onContactActivated({
    contactId,
    contact,
  }: {
    contactId: number;
    contact: any;
  }) {
    const subject =
      contact.contactService === 'vendor'
        ? AbilitySubject.Vendor
        : AbilitySubject.Customer;
    await this.write(null, 'activated', subject, contactId, {
      displayName: contact.displayName,
      email: contact.email,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.contacts.onInactivated, { suppressErrors: true })
  async onContactInactivated({
    contactId,
    contact,
  }: {
    contactId: number;
    contact: any;
  }) {
    const subject =
      contact.contactService === 'vendor'
        ? AbilitySubject.Vendor
        : AbilitySubject.Customer;
    await this.write(null, 'inactivated', subject, contactId, {
      displayName: contact.displayName,
      email: contact.email,
    });
  }

  // --- Inventory adjustments ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.inventoryAdjustment.onQuickCreated, { suppressErrors: true })
  async onInventoryAdjustmentCreated({
    inventoryAdjustment,
    inventoryAdjustmentId,
    trx,
  }: IInventoryAdjustmentEventCreatedPayload) {
    await this.write(
      trx,
      'created',
      AbilitySubject.InventoryAdjustment,
      inventoryAdjustmentId,
      { reason: inventoryAdjustment.reason },
    );
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.inventoryAdjustment.onPublished, { suppressErrors: true })
  async onInventoryAdjustmentPublished({
    inventoryAdjustment,
    inventoryAdjustmentId,
    trx,
  }: IInventoryAdjustmentEventPublishedPayload) {
    await this.write(
      trx,
      'published',
      AbilitySubject.InventoryAdjustment,
      inventoryAdjustmentId,
      { reason: inventoryAdjustment.reason },
    );
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.inventoryAdjustment.onDeleted, { suppressErrors: true })
  async onInventoryAdjustmentDeleted({
    inventoryAdjustmentId,
    trx,
  }: IInventoryAdjustmentEventDeletedPayload) {
    await this.write(
      trx,
      'deleted',
      AbilitySubject.InventoryAdjustment,
      inventoryAdjustmentId,
      {},
    );
  }

  // --- Warehouse transfers ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.warehouseTransfer.onCreated, { suppressErrors: true })
  async onWarehouseTransferCreated({
    warehouseTransfer,
    trx,
  }: IWarehouseTransferCreated) {
    await this.write(
      trx,
      'created',
      'WarehouseTransfer',
      warehouseTransfer.id,
      {
        transactionNumber: (warehouseTransfer as { transactionNumber?: string })
          .transactionNumber,
      },
    );
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.warehouseTransfer.onEdited, { suppressErrors: true })
  async onWarehouseTransferEdited({
    warehouseTransfer,
    trx,
  }: IWarehouseTransferEditedPayload) {
    await this.write(trx, 'edited', 'WarehouseTransfer', warehouseTransfer.id, {
      transactionNumber: (warehouseTransfer as { transactionNumber?: string })
        .transactionNumber,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.warehouseTransfer.onDeleted, { suppressErrors: true })
  async onWarehouseTransferDeleted({
    oldWarehouseTransfer,
    trx,
  }: IWarehouseTransferDeletedPayload) {
    await this.write(
      trx,
      'deleted',
      'WarehouseTransfer',
      oldWarehouseTransfer.id,
      {},
    );
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.warehouseTransfer.onInitiated, { suppressErrors: true })
  async onWarehouseTransferInitiated({
    warehouseTransfer,
    trx,
  }: IWarehouseTransferInitiatedPayload) {
    await this.write(
      trx,
      'initiated',
      'WarehouseTransfer',
      warehouseTransfer.id,
      {
        transactionNumber: (warehouseTransfer as { transactionNumber?: string })
          .transactionNumber,
      },
    );
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.warehouseTransfer.onTransferred, { suppressErrors: true })
  async onWarehouseTransferTransferred({
    warehouseTransfer,
    trx,
  }: IWarehouseTransferTransferredPayload) {
    await this.write(
      trx,
      'transferred',
      'WarehouseTransfer',
      warehouseTransfer.id,
      {
        transactionNumber: (warehouseTransfer as { transactionNumber?: string })
          .transactionNumber,
      },
    );
  }

  // --- Transactions locking (settings change; no trx on payload) ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.transactionsLocking.partialUnlocked, { suppressErrors: true })
  async onTransactionsLockingChanged(
    payload: ITransactionsLockingPartialUnlocked | ITransactionsLockingCanceled,
  ) {
    const meta: Record<string, unknown> = { module: payload.module };
    if ('transactionLockingDTO' in payload && payload.transactionLockingDTO) {
      meta.lockToDate = (
        payload.transactionLockingDTO as { lockToDate?: Date }
      ).lockToDate;
    }
    if ('cancelLockingDTO' in payload && payload.cancelLockingDTO) {
      meta.cancelReason = (
        payload.cancelLockingDTO as { reason?: string }
      ).reason;
    }
    await this.write(
      undefined,
      'locking_changed',
      'TransactionsLocking',
      null,
      meta,
    );
  }

  // --- Sale estimates ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.saleEstimate.onCreated, { suppressErrors: true })
  async onSaleEstimateCreated({
    saleEstimate,
    saleEstimateId,
    trx,
  }: ISaleEstimateCreatedPayload) {
    await this.write(
      trx,
      'created',
      AbilitySubject.SaleEstimate,
      saleEstimate?.id ?? saleEstimateId,
      {
        estimateNumber: saleEstimate.estimateNumber,
        total: saleEstimate.total,
        currencyCode: saleEstimate.currencyCode,
      },
    );
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.saleEstimate.onEdited, { suppressErrors: true })
  async onSaleEstimateEdited({
    saleEstimate,
    estimateId,
    trx,
  }: ISaleEstimateEditedPayload) {
    await this.write(trx, 'edited', AbilitySubject.SaleEstimate, estimateId, {
      estimateNumber: saleEstimate.estimateNumber,
      total: saleEstimate.total,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.saleEstimate.onDeleted, { suppressErrors: true })
  async onSaleEstimateDeleted({
    saleEstimateId,
    oldSaleEstimate,
    trx,
  }: ISaleEstimateDeletedPayload) {
    await this.write(
      trx,
      'deleted',
      AbilitySubject.SaleEstimate,
      saleEstimateId,
      { estimateNumber: oldSaleEstimate.estimateNumber },
    );
  }

  // --- Items ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.item.onCreated, { suppressErrors: true })
  async onItemCreated({ item, itemId, trx }: IItemEventCreatedPayload) {
    await this.write(trx, 'created', AbilitySubject.Item, itemId, {
      name: item.name,
      code: item.code,
      type: item.type,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.item.onEdited, { suppressErrors: true })
  async onItemEdited({ item, itemId, trx }: IItemEventEditedPayload) {
    await this.write(trx, 'edited', AbilitySubject.Item, itemId, {
      name: item.name,
      code: item.code,
      type: item.type,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.item.onDeleted, { suppressErrors: true })
  async onItemDeleted({ itemId, oldItem, trx }: IItemEventDeletedPayload) {
    await this.write(trx, 'deleted', AbilitySubject.Item, itemId, {
      name: oldItem.name,
      code: oldItem.code,
      type: oldItem.type,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.item.onActivated, { suppressErrors: true })
  async onItemActivated({ item, itemId, trx }: IItemEventActivatedPayload) {
    await this.write(trx, 'activated', AbilitySubject.Item, itemId, {
      name: item.name,
      code: item.code,
      type: item.type,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.item.onInactivated, { suppressErrors: true })
  async onItemInactivated({ item, itemId, trx }: IItemEventInactivatedPayload) {
    await this.write(trx, 'inactivated', AbilitySubject.Item, itemId, {
      name: item.name,
      code: item.code,
      type: item.type,
    });
  }

  // --- Customers ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.customers.onCreated, { suppressErrors: true })
  async onCustomerCreated({
    customer,
    customerId,
    trx,
  }: ICustomerEventCreatedPayload) {
    await this.write(trx, 'created', AbilitySubject.Customer, customerId, {
      displayName: customer.displayName,
      email: customer.email,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.customers.onEdited, { suppressErrors: true })
  async onCustomerEdited({
    customer,
    customerId,
    trx,
  }: ICustomerEventEditedPayload) {
    await this.write(trx, 'edited', AbilitySubject.Customer, customerId, {
      displayName: customer.displayName,
      email: customer.email,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.customers.onDeleted, { suppressErrors: true })
  async onCustomerDeleted({
    customerId,
    oldCustomer,
    trx,
  }: ICustomerEventDeletedPayload) {
    await this.write(trx, 'deleted', AbilitySubject.Customer, customerId, {
      displayName: oldCustomer.displayName,
      email: oldCustomer.email,
    });
  }

  // --- Vendors ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.vendors.onCreated, { suppressErrors: true })
  async onVendorCreated({ vendor, vendorId, trx }: IVendorEventCreatedPayload) {
    await this.write(trx, 'created', AbilitySubject.Vendor, vendorId, {
      displayName: vendor.displayName,
      email: vendor.email,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.vendors.onEdited, { suppressErrors: true })
  async onVendorEdited({ vendor, vendorId, trx }: IVendorEventEditedPayload) {
    await this.write(trx, 'edited', AbilitySubject.Vendor, vendorId, {
      displayName: vendor.displayName,
      email: vendor.email,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.vendors.onDeleted, { suppressErrors: true })
  async onVendorDeleted({
    vendorId,
    oldVendor,
    trx,
  }: IVendorEventDeletedPayload) {
    await this.write(trx, 'deleted', AbilitySubject.Vendor, vendorId, {
      displayName: oldVendor.displayName,
      email: oldVendor.email,
    });
  }

  // --- Roles ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.roles.onCreated, { suppressErrors: true })
  async onRoleCreated({ role, trx }: IRoleCreatedPayload) {
    await this.write(trx, 'created', AbilitySubject.Role, role.id, {
      roleName: role.name,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.roles.onEdited, { suppressErrors: true })
  async onRoleEdited({ role, oldRole, trx }: IRoleEditedPayload) {
    await this.write(trx, 'edited', AbilitySubject.Role, role.id, {
      roleName: role.name,
      oldRoleName: oldRole.name,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.roles.onDeleted, { suppressErrors: true })
  async onRoleDeleted({ roleId, oldRole, trx }: IRoleDeletedPayload) {
    await this.write(trx, 'deleted', AbilitySubject.Role, roleId, {
      roleName: oldRole.name,
    });
  }

  // --- Tax Rates ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.taxRates.onCreated, { suppressErrors: true })
  async onTaxRateCreated({ taxRate, trx }: ITaxRateCreatedPayload) {
    await this.write(trx, 'created', AbilitySubject.TaxRate, taxRate.id, {
      name: taxRate.name,
      rate: taxRate.rate,
      code: taxRate.code,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.taxRates.onEdited, { suppressErrors: true })
  async onTaxRateEdited({
    taxRate,
    oldTaxRate: _oldTaxRate,
    trx,
  }: ITaxRateEditedPayload) {
    await this.write(trx, 'edited', AbilitySubject.TaxRate, taxRate.id, {
      name: taxRate.name,
      rate: taxRate.rate,
      code: taxRate.code,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.taxRates.onDeleted, { suppressErrors: true })
  async onTaxRateDeleted({ oldTaxRate, trx }: ITaxRateDeletedPayload) {
    await this.write(trx, 'deleted', AbilitySubject.TaxRate, oldTaxRate.id, {
      name: oldTaxRate.name,
      rate: oldTaxRate.rate,
      code: oldTaxRate.code,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.taxRates.onActivated, { suppressErrors: true })
  async onTaxRateActivated({ taxRateId, trx }: ITaxRateActivatedPayload) {
    await this.write(trx, 'activated', AbilitySubject.TaxRate, taxRateId, {});
  }

  // --- Warehouse ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.warehouse.onCreated, { suppressErrors: true })
  async onWarehouseCreated({
    warehouse,
    warehouseDTO,
    trx,
  }: IWarehouseCreatedPayload) {
    await this.write(trx, 'created', AbilitySubject.Warehouse, warehouse.id, {
      code: warehouseDTO.code,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.warehouse.onEdited, { suppressErrors: true })
  async onWarehouseEdited({
    warehouse,
    warehouseDTO,
    trx,
  }: IWarehouseEditedPayload) {
    await this.write(trx, 'edited', AbilitySubject.Warehouse, warehouse.id, {
      code: warehouseDTO.code,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.warehouse.onDeleted, { suppressErrors: true })
  async onWarehouseDeleted({ warehouseId, trx }: IWarehouseDeletedPayload) {
    await this.write(trx, 'deleted', AbilitySubject.Warehouse, warehouseId, {});
  }

  // --- Branches ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.branch.onActivated, { suppressErrors: true })
  async onBranchActivated({ primaryBranch, trx }: IBranchesActivatedPayload) {
    await this.write(
      trx,
      'activated',
      AbilitySubject.Branch,
      primaryBranch.id,
      {
        name: primaryBranch.name,
        code: primaryBranch.code,
      },
    );
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.branch.onMarkedPrimary, { suppressErrors: true })
  async onBranchMarkedPrimary({
    markedBranch,
    trx,
  }: IBranchMarkedAsPrimaryPayload) {
    await this.write(
      trx,
      'marked_primary',
      AbilitySubject.Branch,
      markedBranch.id,
      {
        name: markedBranch.name,
        code: markedBranch.code,
      },
    );
  }

  // --- Item Category ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.itemCategory.onCreated, { suppressErrors: true })
  async onItemCategoryCreated({
    itemCategory,
    trx,
  }: IItemCategoryCreatedPayload) {
    await this.write(trx, 'created', 'ItemCategory', itemCategory.id, {
      name: itemCategory.name,
      description: itemCategory.description,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.itemCategory.onEdited, { suppressErrors: true })
  async onItemCategoryEdited({
    oldItemCategory,
    trx,
  }: IItemCategoryEditedPayload) {
    await this.write(trx, 'edited', 'ItemCategory', oldItemCategory.id, {
      name: oldItemCategory.name,
      description: oldItemCategory.description,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.itemCategory.onDeleted, { suppressErrors: true })
  async onItemCategoryDeleted({
    itemCategoryId,
    oldItemCategory,
    trx,
  }: IItemCategoryDeletedPayload) {
    await this.write(trx, 'deleted', 'ItemCategory', itemCategoryId, {
      name: oldItemCategory.name,
    });
  }

  // --- Bank Rules ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.bankRules.onCreated, { suppressErrors: true })
  async onBankRuleCreated({ bankRule, trx }: IBankRuleEventCreatedPayload) {
    await this.write(trx, 'created', 'BankRule', bankRule.id, {
      name: bankRule.name,
      applyIfAccountId: bankRule.applyIfAccountId,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.bankRules.onEdited, { suppressErrors: true })
  async onBankRuleEdited({
    bankRule,
    oldBankRule: _oldBankRule,
    trx,
  }: IBankRuleEventEditedPayload) {
    await this.write(trx, 'edited', 'BankRule', bankRule.id, {
      name: bankRule.name,
      applyIfAccountId: bankRule.applyIfAccountId,
    });
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.bankRules.onDeleted, { suppressErrors: true })
  async onBankRuleDeleted({ ruleId, trx }: IBankRuleEventDeletedPayload) {
    await this.write(trx, 'deleted', 'BankRule', ruleId, {});
  }

  // --- Uncategorized Transactions (Imported) ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.cashflow.onTransactionUncategorizedCreated, {
    suppressErrors: true,
  })
  async onUncategorizedTransactionCreated({
    uncategorizedTransaction,
    trx,
  }: IUncategorizedTransactionCreatedEventPayload) {
    await this.write(
      trx,
      'created',
      'UncategorizedTransaction',
      uncategorizedTransaction.id,
      {
        amount: uncategorizedTransaction.amount,
        currencyCode: uncategorizedTransaction.currencyCode,
        payee: uncategorizedTransaction.payee,
        description: uncategorizedTransaction.description,
        plaidTransactionId: uncategorizedTransaction.plaidTransactionId,
      },
    );
  }

  // --- Plaid Sync Events ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.plaid.onTransactionsSynced, { suppressErrors: true })
  async onPlaidTransactionsSynced({
    plaidAccountId,
    batch,
    trx,
  }: IPlaidTransactionsSyncedEventPayload) {
    await this.write(trx, 'synced', 'PlaidTransactions', null, {
      plaidAccountId,
      batch,
    });
  }

  // --- Plaid webhook received ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.plaid.onWebhookReceived, { suppressErrors: true })
  async onPlaidWebhookReceived({
    plaidItemId,
    webhookType,
    webhookCode,
  }: IPlaidWebhookReceivedEventPayload) {
    await this.write(undefined, 'webhook_received', 'PlaidWebhook', null, {
      plaidItemId,
      webhookType,
      webhookCode,
    });
  }

  // --- Excluded Bank Transactions ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.bankTransactions.onExcluded, { suppressErrors: true })
  async onBankTransactionExcluded({
    uncategorizedTransactionId,
    uncategorizedTransaction,
    trx,
  }: IBankTransactionExcludedEventPayload) {
    await this.write(
      trx,
      'excluded',
      'BankTransaction',
      uncategorizedTransactionId,
      {
        amount: uncategorizedTransaction?.amount,
        currencyCode: uncategorizedTransaction?.currencyCode,
        payee: uncategorizedTransaction?.payee,
        description: uncategorizedTransaction?.description,
        accountId: uncategorizedTransaction?.accountId,
      },
    );
  }

  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.bankTransactions.onUnexcluded, { suppressErrors: true })
  async onBankTransactionUnexcluded({
    uncategorizedTransactionId,
    uncategorizedTransaction,
    trx,
  }: IBankTransactionUnexcludedEventPayload) {
    await this.write(
      trx,
      'unexcluded',
      'BankTransaction',
      uncategorizedTransactionId,
      {
        amount: uncategorizedTransaction?.amount,
        currencyCode: uncategorizedTransaction?.currencyCode,
        payee: uncategorizedTransaction?.payee,
        description: uncategorizedTransaction?.description,
        accountId: uncategorizedTransaction?.accountId,
      },
    );
  }

  // --- Plaid item linked ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.plaid.onItemCreated, { suppressErrors: true })
  async onPlaidItemCreated({
    plaidItemId,
    plaidInstitutionId,
  }: IPlaidItemCreatedEventPayload) {
    await this.write(undefined, 'linked', 'PlaidItem', null, {
      plaidItemId,
      plaidInstitutionId,
    });
  }

  // --- Bank account disconnected ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.bankAccount.onDisconnected, { suppressErrors: true })
  async onBankAccountDisconnected({
    bankAccountId,
    trx,
  }: IBankAccountDisconnectedEventPayload) {
    await this.write(trx, 'disconnected', 'BankAccount', bankAccountId, {
      bankAccountId,
    });
  }

  // --- Bank transaction matched ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.bankMatch.onMatched, { suppressErrors: true })
  async onBankTransactionMatched({
    uncategorizedTransactionIds,
    matchedTransactions,
    trx,
  }: IBankTransactionMatchedEventPayload) {
    await this.write(trx, 'matched', 'BankTransaction', null, {
      uncategorizedTransactionIds,
      matchedTransactions,
      count: uncategorizedTransactionIds?.length,
    });
  }

  // --- Bank transaction unmatched ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.bankMatch.onUnmatched, { suppressErrors: true })
  async onBankTransactionUnmatched({
    uncategorizedTransactionId,
    trx,
  }: IBankTransactionUnmatchedEventPayload) {
    await this.write(
      trx,
      'unmatched',
      'BankTransaction',
      uncategorizedTransactionId,
      { uncategorizedTransactionId },
    );
  }

  // --- Pending bank transaction removed ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.bankTransactions.onPendingRemoved, { suppressErrors: true })
  async onPendingTransactionRemoved({
    uncategorizedTransactionId,
    pendingTransaction,
    trx,
  }: IPendingTransactionRemovedEventPayload) {
    await this.write(
      trx,
      'removed',
      'UncategorizedTransaction',
      uncategorizedTransactionId,
      {
        amount: pendingTransaction?.amount,
        currencyCode: pendingTransaction?.currencyCode,
        payee: pendingTransaction?.payee,
        description: pendingTransaction?.description,
        accountId: pendingTransaction?.accountId,
      },
    );
  }

  // --- Bank transactions recognized ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.bankRecognize.onRecognized, { suppressErrors: true })
  async onBankTransactionsRecognized({
    ruleId,
    uncategorizedTransactionIds,
    recognizedCount,
    trx,
  }: IBankTransactionRecognizedEventPayload) {
    await this.write(trx, 'recognized', 'RecognizedTransaction', null, {
      ruleId,
      count: recognizedCount,
      uncategorizedTransactionIds,
    });
  }

  // --- Bank transactions reverted ---
  // Side effect (audit log): an error is logged and does not stop the save.
  @OnEvent(events.bankRecognize.onReverted, { suppressErrors: true })
  async onBankTransactionsReverted({
    ruleId,
    uncategorizedTransactionIds,
    trx,
  }: IBankTransactionRevertedEventPayload) {
    await this.write(trx, 'reverted', 'RecognizedTransaction', null, {
      ruleId,
      uncategorizedTransactionIds,
    });
  }
}
