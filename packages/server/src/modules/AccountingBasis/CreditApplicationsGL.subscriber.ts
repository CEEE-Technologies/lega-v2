import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { events } from '@/common/events/events';
import {
  CREDIT_NOTE_APPLICATIONS,
  CreditApplicationsGLService,
  VENDOR_CREDIT_APPLICATIONS,
} from './CreditApplicationsGL.service';

const idsOf = (key: string, ...lists: Array<any[] | undefined>) =>
  lists
    .flatMap((list) => list || [])
    .map((entry) => entry?.[key])
    .filter(Boolean);

/**
 * Keeps the exchange lines of the credit applications (see
 * CreditApplicationsGLService) in step with what they depend on: the
 * applications themselves, the payments of the documents and the document
 * and credit rates.
 */
@Injectable()
export class CreditApplicationsGLSubscriber {
  constructor(private readonly service: CreditApplicationsGLService) {}

  // --- Credit notes applied to invoices ---

  @OnEvent(events.creditNote.onApplyToInvoicesCreated)
  async onCreditNoteApplied({ creditNote, creditNoteAppliedInvoices, trx }) {
    await this.service.rebuild(
      CREDIT_NOTE_APPLICATIONS,
      {
        documentIds: idsOf('invoiceId', creditNoteAppliedInvoices),
        creditIds: [creditNote?.id],
      },
      trx,
    );
  }

  @OnEvent(events.creditNote.onApplyToInvoicesDeleted)
  async onCreditNoteUnapplied({ creditNote, creditNoteAppliedToInvoice, trx }) {
    await this.service.rebuild(
      CREDIT_NOTE_APPLICATIONS,
      {
        documentIds: [creditNoteAppliedToInvoice?.invoiceId],
        creditIds: [creditNote?.id ?? creditNoteAppliedToInvoice?.creditNoteId],
        removedIds: [creditNoteAppliedToInvoice?.id],
      },
      trx,
    );
  }

  @OnEvent(events.creditNote.onEdited)
  async onCreditNoteEdited({ creditNote, trx }) {
    await this.service.rebuild(
      CREDIT_NOTE_APPLICATIONS,
      { creditIds: [creditNote?.id] },
      trx,
    );
  }

  @OnEvent(events.saleInvoice.onEdited)
  async onInvoiceEdited({ saleInvoiceId, saleInvoice, trx }) {
    await this.service.rebuild(
      CREDIT_NOTE_APPLICATIONS,
      { documentIds: [saleInvoiceId ?? saleInvoice?.id] },
      trx,
    );
  }

  @OnEvent(events.paymentReceive.onCreated)
  @OnEvent(events.paymentReceive.onEdited)
  @OnEvent(events.paymentReceive.onDeleted)
  async onPaymentReceived({
    paymentReceive,
    oldPaymentReceive,
    paymentReceiveDTO,
    trx,
  }) {
    await this.service.rebuild(
      CREDIT_NOTE_APPLICATIONS,
      {
        documentIds: idsOf(
          'invoiceId',
          paymentReceive?.entries,
          oldPaymentReceive?.entries,
          paymentReceiveDTO?.entries,
        ),
      },
      trx,
    );
  }

  // --- Vendor credits applied to bills ---

  @OnEvent(events.vendorCredit.onApplyToInvoicesCreated)
  async onVendorCreditApplied({ vendorCredit, vendorCreditAppliedBills, trx }) {
    await this.service.rebuild(
      VENDOR_CREDIT_APPLICATIONS,
      {
        documentIds: idsOf('billId', vendorCreditAppliedBills),
        creditIds: [vendorCredit?.id],
      },
      trx,
    );
  }

  @OnEvent(events.vendorCredit.onApplyToInvoicesDeleted)
  async onVendorCreditUnapplied({ vendorCredit, oldCreditAppliedToBill, trx }) {
    await this.service.rebuild(
      VENDOR_CREDIT_APPLICATIONS,
      {
        documentIds: [oldCreditAppliedToBill?.billId],
        creditIds: [vendorCredit?.id ?? oldCreditAppliedToBill?.vendorCreditId],
        removedIds: [oldCreditAppliedToBill?.id],
      },
      trx,
    );
  }

  @OnEvent(events.vendorCredit.onEdited)
  async onVendorCreditEdited({ vendorCredit, trx }) {
    await this.service.rebuild(
      VENDOR_CREDIT_APPLICATIONS,
      { creditIds: [vendorCredit?.id] },
      trx,
    );
  }

  @OnEvent(events.bill.onEdited)
  async onBillEdited({ bill, trx }) {
    await this.service.rebuild(
      VENDOR_CREDIT_APPLICATIONS,
      { documentIds: [bill?.id] },
      trx,
    );
  }

  @OnEvent(events.billPayment.onCreated)
  @OnEvent(events.billPayment.onEdited)
  @OnEvent(events.billPayment.onDeleted)
  async onBillPayment({ billPayment, oldBillPayment, billPaymentDTO, trx }) {
    await this.service.rebuild(
      VENDOR_CREDIT_APPLICATIONS,
      {
        documentIds: idsOf(
          'billId',
          billPayment?.entries,
          oldBillPayment?.entries,
          billPaymentDTO?.entries,
        ),
      },
      trx,
    );
  }
}
