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
  async onAccountActivated({ accountId, trx }: IAccountEventActivatedPayload) {
    await this.write(trx, 'activated', AbilitySubject.Account, accountId, {});
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
}
