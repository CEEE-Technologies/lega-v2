import request = require('supertest');
import { faker } from '@faker-js/faker';
import { app } from './init-app-test';
import { authHeaders } from './_utils/gl';
import {
  DOCUMENT_DATE,
  DUE_DATE,
  describeDocumentParity,
  dueOfRow,
  rowsOf,
} from './_utils/money-parity-documents';
import { SALE_INVOICE_MONEY_SQL } from '../src/modules/SaleInvoices/models/SaleInvoice';

/**
 * Money parity matrix on invoices: see money-parity-documents.ts. The
 * Receive Payment form due list, the credit note "apply to invoices"
 * dialog, the A/R aging summary and the A/R ledger line all give the
 * invoice's one answer.
 */
describeDocumentParity({
  label: 'invoices',
  contactKind: 'customers',
  documentType: 'SaleInvoice',
  paymentType: 'PaymentReceive',
  path: '/sale-invoices',
  table: 'SALES_INVOICES',
  subtotalColumn: 'BALANCE',
  moneySql: SALE_INVOICE_MONEY_SQL,
  documentBody: (customerId, invoiceNo) => ({
    customerId,
    invoiceDate: DOCUMENT_DATE,
    dueDate: DUE_DATE,
    invoiceNo,
    delivered: true,
    branchId: 1,
    warehouseId: 1,
  }),
  pay: async (customerId, invoiceId, amount, exchangeRate) => {
    const res = await request(app.getHttpServer())
      .post('/payments-received')
      .set(authHeaders())
      .send({
        customerId,
        paymentDate: '2025-03-05',
        exchangeRate,
        depositAccountId: 1000,
        paymentReceiveNo: faker.string.uuid(),
        amount,
        entries: [{ index: 1, invoiceId, paymentAmount: amount }],
        branchId: 1,
      });
    if (res.status !== 201) {
      throw new Error(`payment ${amount}: ${JSON.stringify(res.body)}`);
    }
    return res.body.id;
  },
  payMany: async (customerId, entries, amount, exchangeRate) => {
    const res = await request(app.getHttpServer())
      .post('/payments-received')
      .set(authHeaders())
      .send({
        customerId,
        paymentDate: '2025-03-05',
        exchangeRate,
        depositAccountId: 1000,
        paymentReceiveNo: faker.string.uuid(),
        amount,
        entries: entries.map((entry, index) => ({
          index: index + 1,
          invoiceId: entry.documentId,
          paymentAmount: entry.amount,
        })),
        branchId: 1,
      });
    if (res.status !== 201) {
      throw new Error(`payment of many ${amount}: ${JSON.stringify(res.body)}`);
    }
    return res.body.id;
  },
  dueInPaymentForm: async (customerId, invoiceId) => {
    const res = await request(app.getHttpServer())
      .get('/payments-received/new-page/entries')
      .query({ customerId })
      .set(authHeaders())
      .expect(200);
    return dueOfRow(rowsOf(res.body), invoiceId, ['invoiceId', 'id']);
  },
  createCredit: async (customerId, exchangeRate, itemId) => {
    const res = await request(app.getHttpServer())
      .post('/credit-notes')
      .set(authHeaders())
      .send({
        customerId,
        creditNoteDate: DOCUMENT_DATE,
        open: true,
        exchangeRate,
        branchId: 1,
        warehouseId: 1,
        entries: [{ index: 1, itemId, quantity: 1, rate: 1 }],
      })
      .expect(201);
    return res.body.id;
  },
  dueInCreditApply: async (creditNoteId, invoiceId) => {
    const res = await request(app.getHttpServer())
      .get(`/credit-notes/${creditNoteId}/apply-invoices`)
      .set(authHeaders())
      .expect(200);
    return dueOfRow(rowsOf(res.body), invoiceId, ['id', 'invoiceId']);
  },
  agingPath: '/reports/receivable-aging-summary',
  contactSign: 1,
});
