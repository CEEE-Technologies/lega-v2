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
import { BILL_MONEY_SQL } from '../src/modules/Bills/models/Bill';

/**
 * Money parity matrix on bills: see money-parity-documents.ts. The Pay Bill
 * form due list, the vendor credit "apply to bills" dialog, the A/P aging
 * summary and the A/P ledger line all give the bill's one answer.
 */
describeDocumentParity({
  label: 'bills',
  contactKind: 'vendors',
  documentType: 'Bill',
  paymentType: 'BillPayment',
  path: '/bills',
  table: 'BILLS',
  subtotalColumn: 'AMOUNT',
  moneySql: BILL_MONEY_SQL,
  documentBody: (vendorId, billNumber) => ({
    vendorId,
    billDate: DOCUMENT_DATE,
    dueDate: DUE_DATE,
    billNumber,
    open: true,
    branchId: 1,
    warehouseId: 1,
  }),
  pay: async (vendorId, billId, amount, exchangeRate) => {
    const res = await request(app.getHttpServer())
      .post('/bill-payments')
      .set(authHeaders())
      .send({
        vendorId,
        paymentDate: '2025-03-05',
        exchangeRate,
        paymentAccountId: 1000,
        paymentNumber: faker.string.alphanumeric(12),
        amount,
        entries: [{ index: 1, billId, paymentAmount: amount }],
        branchId: 1,
      });
    if (res.status !== 201) {
      throw new Error(`bill payment ${amount}: ${JSON.stringify(res.body)}`);
    }
    return res.body.id;
  },
  dueInPaymentForm: async (vendorId, billId) => {
    const res = await request(app.getHttpServer())
      .get('/bill-payments/new-page/entries')
      .query({ vendorId })
      .set(authHeaders())
      .expect(200);
    return dueOfRow(rowsOf(res.body), billId, ['billId', 'id']);
  },
  createCredit: async (vendorId, exchangeRate, itemId) => {
    const res = await request(app.getHttpServer())
      .post('/vendor-credits')
      .set(authHeaders())
      .send({
        vendorId,
        exchangeRate,
        vendorCreditNumber: faker.string.alphanumeric(12),
        vendorCreditDate: DOCUMENT_DATE,
        open: true,
        branchId: 1,
        warehouseId: 1,
        entries: [{ index: 1, itemId, quantity: 1, rate: 1 }],
      })
      .expect(201);
    return res.body.id;
  },
  dueInCreditApply: async (vendorCreditId, billId) => {
    const res = await request(app.getHttpServer())
      .get(`/vendor-credits/${vendorCreditId}/bills-to-apply`)
      .set(authHeaders())
      .expect(200);
    return dueOfRow(rowsOf(res.body), billId, ['id', 'billId']);
  },
  agingPath: '/reports/payable-aging-summary',
  contactSign: -1,
});
