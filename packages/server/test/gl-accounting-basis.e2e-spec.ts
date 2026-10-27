import request = require('supertest');
import { faker } from '@faker-js/faker';
import { app } from './init-app-test';
import {
  authHeaders,
  cancelTransactionsLock,
  createCustomer,
  createServiceItem,
  createVendor,
  expectBalanced,
  fetchLegs,
  getBaseCurrency,
  GLTestLeg,
} from './_utils/gl';
import {
  collectAccountNodes,
  fetchAccountsByCode,
} from './_utils/balance-sheet';

interface TrialBalanceRow {
  id: number;
  debit: number;
  credit: number;
  balance: number;
}

/**
 * E2E assertions of the cash vs accrual accounting basis reports.
 *
 * Fixtures are seeded on unique far-future dates so the report totals of the
 * shared tenant database only contain the transactions created here.
 */
describe('Accounting basis — cash vs accrual reports (e2e)', () => {
  const range = { fromDate: '2033-06-01', toDate: '2033-06-30' };
  const invoiceDate = '2033-06-15';
  const paymentDate = '2033-06-16';

  const INCOME_ACCOUNT_CODE = '50002';
  const AR_ACCOUNT_CODE = '10007';

  let customerId: number;
  let itemId: number;
  let incomeAccountId: number;
  let arAccountId: number;

  let baseline: {
    incomeAccrual: number;
    incomeCash: number;
    arAccrual: TrialBalanceRow;
    arCash: TrialBalanceRow;
  };

  /**
   * Fetches the profit & loss income total of the tested account.
   */
  const fetchIncomeTotal = async (basis: 'cash' | 'accrual') => {
    const res = await request(app.getHttpServer())
      .get('/reports/profit-loss-sheet')
      .query({ ...range, basis })
      .set(authHeaders())
      .expect(200);

    const node = collectAccountNodes(res.body.data).find(
      (n) => Number(n.id) === incomeAccountId,
    );
    return node ? Number(node.total.amount) : 0;
  };

  /**
   * Deeply searches the trial balance account nodes by account id.
   */
  const findAccountRow = (nodes: any[], accountId: number): any | undefined => {
    for (const node of nodes ?? []) {
      if (Number(node.id) === accountId) return node;
      const found = findAccountRow(node.children ?? [], accountId);
      if (found) return found;
    }
    return undefined;
  };

  /**
   * Fetches the trial balance row of the tested account.
   */
  const fetchTrialBalanceRow = async (
    accountId: number,
    basis: 'cash' | 'accrual',
  ): Promise<TrialBalanceRow> => {
    const res = await request(app.getHttpServer())
      .get('/reports/trial-balance-sheet')
      .query({ ...range, basis })
      .set(authHeaders())
      .expect(200);

    const row = findAccountRow(res.body.data.accounts ?? [], accountId);
    return {
      id: accountId,
      debit: Number(row?.debit ?? 0),
      credit: Number(row?.credit ?? 0),
      balance: Number(row?.balance ?? 0),
    };
  };

  const createInvoice = async () => {
    const res = await request(app.getHttpServer())
      .post('/sale-invoices')
      .set(authHeaders())
      .send({
        customerId,
        invoiceDate,
        dueDate: invoiceDate,
        invoiceNo: faker.string.uuid(),
        referenceNo: `BASIS-${faker.string.alphanumeric({ length: 6 })}`,
        delivered: true,
        branchId: 1,
        warehouseId: 1,
        entries: [
          {
            index: 1,
            itemId,
            quantity: 1,
            rate: 1000,
            description: 'Accounting basis test item',
          },
        ],
      })
      .expect(201);

    return res.body.id;
  };

  const createPayment = async (invoiceId: number) => {
    const res = await request(app.getHttpServer())
      .post('/payments-received')
      .set(authHeaders())
      .send({
        customerId,
        paymentDate,
        exchangeRate: 1,
        referenceNo: faker.string.uuid(),
        depositAccountId: 1000,
        paymentReceiveNo: faker.string.uuid(),
        statement: 'Accounting basis test payment',
        entries: [{ index: 1, invoiceId, paymentAmount: 1000 }],
        branchId: 1,
      })
      .expect(201);

    return res.body.id;
  };

  beforeAll(async () => {
    await cancelTransactionsLock();

    const baseCurrency = await getBaseCurrency();
    customerId = await createCustomer(baseCurrency);
    itemId = await createServiceItem();

    const accountsByCode = await fetchAccountsByCode();
    incomeAccountId = accountsByCode[INCOME_ACCOUNT_CODE].id;
    arAccountId = accountsByCode[AR_ACCOUNT_CODE].id;

    // Capture the baseline numbers before seeding the fixtures.
    baseline = {
      incomeAccrual: await fetchIncomeTotal('accrual'),
      incomeCash: await fetchIncomeTotal('cash'),
      arAccrual: await fetchTrialBalanceRow(arAccountId, 'accrual'),
      arCash: await fetchTrialBalanceRow(arAccountId, 'cash'),
    };
  });

  describe('Delivered sale invoice', () => {
    beforeAll(async () => {
      await createInvoice();
    });

    it('recognizes the income on the accrual basis report', async () => {
      const incomeAccrual = await fetchIncomeTotal('accrual');
      expect(incomeAccrual - baseline.incomeAccrual).toBeCloseTo(1000, 2);
    });

    it('does not recognize the income on the cash basis report', async () => {
      const incomeCash = await fetchIncomeTotal('cash');
      expect(incomeCash - baseline.incomeCash).toBeCloseTo(0, 2);
    });

    it('posts the receivable on the accrual basis trial balance', async () => {
      const arAccrual = await fetchTrialBalanceRow(arAccountId, 'accrual');
      expect(arAccrual.balance - baseline.arAccrual.balance).toBeCloseTo(
        1000,
        2,
      );
    });

    it('has no receivable on the cash basis trial balance', async () => {
      const arCash = await fetchTrialBalanceRow(arAccountId, 'cash');
      expect(arCash.balance - baseline.arCash.balance).toBeCloseTo(0, 2);
    });
  });

  describe('Payment received', () => {
    let invoiceId: number;
    let paymentBaseline: {
      incomeAccrual: number;
      incomeCash: number;
      arAccrual: TrialBalanceRow;
      arCash: TrialBalanceRow;
    };

    beforeAll(async () => {
      // Capture the baseline after the previous invoice fixture.
      paymentBaseline = {
        incomeAccrual: await fetchIncomeTotal('accrual'),
        incomeCash: await fetchIncomeTotal('cash'),
        arAccrual: await fetchTrialBalanceRow(arAccountId, 'accrual'),
        arCash: await fetchTrialBalanceRow(arAccountId, 'cash'),
      };

      invoiceId = await createInvoice();
      await createPayment(invoiceId);
    });

    it('does not double count the income on the accrual basis report', async () => {
      const incomeAccrual = await fetchIncomeTotal('accrual');
      expect(incomeAccrual - paymentBaseline.incomeAccrual).toBeCloseTo(
        1000,
        2,
      );
    });

    it('recognizes the income once on the cash basis report', async () => {
      const incomeCash = await fetchIncomeTotal('cash');
      expect(incomeCash - paymentBaseline.incomeCash).toBeCloseTo(1000, 2);
    });

    it('settles the receivable on the accrual basis trial balance', async () => {
      const arAccrual = await fetchTrialBalanceRow(arAccountId, 'accrual');
      expect(arAccrual.balance - paymentBaseline.arAccrual.balance).toBeCloseTo(
        0,
        2,
      );
    });

    it('keeps no receivable on the cash basis trial balance', async () => {
      const arCash = await fetchTrialBalanceRow(arAccountId, 'cash');
      expect(arCash.balance - paymentBaseline.arCash.balance).toBeCloseTo(0, 2);
    });
  });

  describe('Bills and bill payments', () => {
    const EXPENSE_ACCOUNT_CODE = '40002';
    const AP_ACCOUNT_CODE = '20001';
    const PAYMENT_ACCOUNT_CODE = '10001';

    const billDate = '2033-06-17';
    const billPaymentDate = '2033-06-18';

    let vendorId: number;
    let expenseAccountId: number;
    let apAccountId: number;
    let paymentAccountId: number;

    let baseline: {
      expenseAccrual: number;
      expenseCash: number;
      apAccrual: TrialBalanceRow;
      apCash: TrialBalanceRow;
    };

    /**
     * Fetches the profit & loss expense total of the tested account.
     */
    const fetchExpenseTotal = async (basis: 'cash' | 'accrual') => {
      const res = await request(app.getHttpServer())
        .get('/reports/profit-loss-sheet')
        .query({ ...range, basis })
        .set(authHeaders())
        .expect(200);

      const node = collectAccountNodes(res.body.data).find(
        (n) => Number(n.id) === expenseAccountId,
      );
      return node ? Number(node.total.amount) : 0;
    };

    const createBill = async () => {
      const res = await request(app.getHttpServer())
        .post('/bills')
        .set(authHeaders())
        .send({
          vendorId,
          billDate,
          dueDate: billDate,
          billNumber: faker.string.uuid(),
          referenceNo: `BASIS-${faker.string.alphanumeric({ length: 6 })}`,
          open: true,
          branchId: 1,
          warehouseId: 1,
          entries: [
            {
              index: 1,
              itemId,
              quantity: 1,
              rate: 1000,
              description: 'Accounting basis test purchase',
            },
          ],
        })
        .expect(201);

      return res.body.id;
    };

    const createBillPayment = async (billId: number) => {
      const res = await request(app.getHttpServer())
        .post('/bill-payments')
        .set(authHeaders())
        .send({
          vendorId,
          paymentDate: billPaymentDate,
          exchangeRate: 1,
          reference: faker.string.uuid(),
          paymentAccountId,
          paymentNumber: faker.string.uuid(),
          statement: 'Accounting basis test purchase payment',
          entries: [{ index: 1, billId, paymentAmount: 1000 }],
          branchId: 1,
        })
        .expect(201);

      return res.body.id;
    };

    beforeAll(async () => {
      const baseCurrency = await getBaseCurrency();
      vendorId = await createVendor(baseCurrency);

      const accountsByCode = await fetchAccountsByCode();
      expenseAccountId = accountsByCode[EXPENSE_ACCOUNT_CODE].id;
      apAccountId = accountsByCode[AP_ACCOUNT_CODE].id;
      paymentAccountId = accountsByCode[PAYMENT_ACCOUNT_CODE].id;

      // Capture the baseline numbers before seeding the fixtures.
      baseline = {
        expenseAccrual: await fetchExpenseTotal('accrual'),
        expenseCash: await fetchExpenseTotal('cash'),
        apAccrual: await fetchTrialBalanceRow(apAccountId, 'accrual'),
        apCash: await fetchTrialBalanceRow(apAccountId, 'cash'),
      };
    });

    describe('Opened bill', () => {
      beforeAll(async () => {
        await createBill();
      });

      it('recognizes the purchase expense on the accrual basis report', async () => {
        const expenseAccrual = await fetchExpenseTotal('accrual');
        expect(expenseAccrual - baseline.expenseAccrual).toBeCloseTo(1000, 2);
      });

      it('does not recognize the purchase expense on the cash basis report', async () => {
        const expenseCash = await fetchExpenseTotal('cash');
        expect(expenseCash - baseline.expenseCash).toBeCloseTo(0, 2);
      });

      it('posts the payable on the accrual basis trial balance', async () => {
        const apAccrual = await fetchTrialBalanceRow(apAccountId, 'accrual');
        // A payable is a credit balance (debit - credit), hence the negative.
        expect(apAccrual.balance - baseline.apAccrual.balance).toBeCloseTo(
          -1000,
          2,
        );
      });

      it('has no payable on the cash basis trial balance', async () => {
        const apCash = await fetchTrialBalanceRow(apAccountId, 'cash');
        expect(apCash.balance - baseline.apCash.balance).toBeCloseTo(0, 2);
      });
    });

    describe('Bill payment', () => {
      let paymentBaseline: {
        expenseAccrual: number;
        expenseCash: number;
        apAccrual: TrialBalanceRow;
        apCash: TrialBalanceRow;
        bankAccrual: TrialBalanceRow;
        bankCash: TrialBalanceRow;
      };

      beforeAll(async () => {
        // Capture the baseline after the previous bill fixture.
        paymentBaseline = {
          expenseAccrual: await fetchExpenseTotal('accrual'),
          expenseCash: await fetchExpenseTotal('cash'),
          apAccrual: await fetchTrialBalanceRow(apAccountId, 'accrual'),
          apCash: await fetchTrialBalanceRow(apAccountId, 'cash'),
          bankAccrual: await fetchTrialBalanceRow(paymentAccountId, 'accrual'),
          bankCash: await fetchTrialBalanceRow(paymentAccountId, 'cash'),
        };

        const billId = await createBill();
        await createBillPayment(billId);
      });

      it('does not double count the purchase expense on the accrual basis report', async () => {
        const expenseAccrual = await fetchExpenseTotal('accrual');
        expect(expenseAccrual - paymentBaseline.expenseAccrual).toBeCloseTo(
          1000,
          2,
        );
      });

      it('recognizes the purchase expense on the cash basis report', async () => {
        const expenseCash = await fetchExpenseTotal('cash');
        expect(expenseCash - paymentBaseline.expenseCash).toBeCloseTo(1000, 2);
      });

      it('settles the payable on the accrual basis trial balance', async () => {
        const apAccrual = await fetchTrialBalanceRow(apAccountId, 'accrual');
        expect(
          apAccrual.balance - paymentBaseline.apAccrual.balance,
        ).toBeCloseTo(0, 2);
      });

      it('keeps no payable on the cash basis trial balance', async () => {
        const apCash = await fetchTrialBalanceRow(apAccountId, 'cash');
        expect(apCash.balance - paymentBaseline.apCash.balance).toBeCloseTo(
          0,
          2,
        );
      });

      it('posts the cash outflow once on both bases', async () => {
        const bankAccrual = await fetchTrialBalanceRow(
          paymentAccountId,
          'accrual',
        );
        const bankCash = await fetchTrialBalanceRow(paymentAccountId, 'cash');

        expect(
          paymentBaseline.bankAccrual.balance - bankAccrual.balance,
        ).toBeCloseTo(1000, 2);
        expect(paymentBaseline.bankCash.balance - bankCash.balance).toBeCloseTo(
          1000,
          2,
        );
      });
    });
  });
});

/**
 * E2E assertions of the cash basis entries of unapplied payment amounts,
 * document edits after payment, and the bank register.
 */
describe('Accounting basis — unapplied amounts and document edits (e2e)', () => {
  const OTHER_INCOME_CODE = '50004';
  const UNEARNED_REVENUE_CODE = '50005';
  const OTHER_EXPENSES_CODE = '40011';
  const PREPAID_EXPENSES_CODE = '100010';
  const DISCOUNT_CODE = '40008';
  const PURCHASE_DISCOUNT_CODE = '40009';
  const BANK_ACCOUNT_CODE = '10001';
  const INCOME_ACCOUNT_CODE = '50002';

  const day = (n: number) => `2034-03-${String(n).padStart(2, '0')}`;

  let baseCurrency: string;
  let itemId: number;
  let bankAccountId: number;

  const sumAccount = (
    legs: GLTestLeg[],
    code: string,
    side: 'debit' | 'credit',
  ) =>
    legs
      .filter((leg) => leg.accountCode === code)
      .reduce((sum, leg) => sum + Number(leg[side].amount || 0), 0);

  const createCustomerWithOpeningBalance = async (openingBalance: number) => {
    const res = await request(app.getHttpServer())
      .post('/customers')
      .set(authHeaders())
      .send({
        displayName: `Basis OB Customer ${Date.now()}-${faker.string.alphanumeric({ length: 4 })}`,
        customerType: 'business',
        currencyCode: baseCurrency,
        openingBalance,
        openingBalanceAt: '2034-01-01',
        openingBalanceExchangeRate: 1,
      })
      .expect(201);
    return res.body.id;
  };

  const invoicePayload = (customerId: number, rate: number, extra = {}) => ({
    customerId,
    invoiceDate: day(1),
    dueDate: day(1),
    invoiceNo: faker.string.uuid(),
    delivered: true,
    branchId: 1,
    warehouseId: 1,
    entries: [{ index: 1, itemId, quantity: 1, rate, description: 'Basis' }],
    ...extra,
  });

  const createInvoice = async (customerId: number, rate: number) => {
    const res = await request(app.getHttpServer())
      .post('/sale-invoices')
      .set(authHeaders())
      .send(invoicePayload(customerId, rate))
      .expect(201);
    return res.body.id;
  };

  type PaymentEntry = {
    invoiceId?: number;
    entryType?: 'invoice' | 'opening_balance';
    paymentAmount: number;
  };

  const paymentPayload = (
    customerId: number,
    amount: number,
    entries: PaymentEntry[],
    date = day(5),
  ) => ({
    customerId,
    paymentDate: date,
    amount,
    exchangeRate: 1,
    depositAccountId: bankAccountId,
    paymentReceiveNo: faker.string.uuid(),
    entries: entries.map((e, index) => ({ index: index + 1, ...e })),
    branchId: 1,
  });

  const createPayment = async (
    customerId: number,
    amount: number,
    entries: PaymentEntry[],
    date = day(5),
  ) => {
    const res = await request(app.getHttpServer())
      .post('/payments-received')
      .set(authHeaders())
      .send(paymentPayload(customerId, amount, entries, date))
      .expect(201);
    return res.body.id;
  };

  const openingBalanceEntry = (paymentAmount: number): PaymentEntry => ({
    entryType: 'opening_balance',
    paymentAmount,
  });

  const billPayload = (vendorId: number, rate: number, extra = {}) => ({
    vendorId,
    billDate: day(1),
    dueDate: day(1),
    billNumber: faker.string.uuid(),
    open: true,
    branchId: 1,
    warehouseId: 1,
    entries: [{ index: 1, itemId, quantity: 1, rate, description: 'Basis' }],
    ...extra,
  });

  const createBill = async (vendorId: number, rate: number) => {
    const res = await request(app.getHttpServer())
      .post('/bills')
      .set(authHeaders())
      .send(billPayload(vendorId, rate))
      .expect(201);
    return res.body.id;
  };

  const billPaymentPayload = (
    vendorId: number,
    amount: number,
    entries: {
      billId?: number;
      entryType?: 'invoice' | 'opening_balance';
      paymentAmount: number;
    }[],
  ) => ({
    vendorId,
    paymentDate: day(6),
    amount,
    exchangeRate: 1,
    paymentAccountId: bankAccountId,
    paymentNumber: faker.string.uuid(),
    entries: entries.map((e, index) => ({ index: index + 1, ...e })),
    branchId: 1,
  });

  beforeAll(async () => {
    await cancelTransactionsLock();

    baseCurrency = await getBaseCurrency();
    itemId = await createServiceItem();

    const accountsByCode = await fetchAccountsByCode();
    bankAccountId = accountsByCode[BANK_ACCOUNT_CODE].id;
  });

  describe('Customer payment with an unapplied amount', () => {
    let accrualLegs: GLTestLeg[];
    let cashLegs: GLTestLeg[];

    beforeAll(async () => {
      const customerId = await createCustomer(baseCurrency);
      const invoiceId = await createInvoice(customerId, 1000);
      const paymentId = await createPayment(customerId, 1500, [
        { invoiceId, paymentAmount: 1000 },
      ]);
      accrualLegs = await fetchLegs('PaymentReceive', paymentId, 'accrual');
      cashLegs = (await fetchLegs('PaymentReceive', paymentId, 'cash')).filter(
        (leg) => leg.basis === 'cash',
      );
    });

    it('deposits the same amount in the bank on both bases', () => {
      expect(sumAccount(accrualLegs, BANK_ACCOUNT_CODE, 'debit')).toBeCloseTo(
        1500,
        2,
      );
      expect(sumAccount(cashLegs, BANK_ACCOUNT_CODE, 'debit')).toBeCloseTo(
        1500,
        2,
      );
    });

    it('records the unapplied amount as unearned revenue on the cash basis', () => {
      expect(sumAccount(cashLegs, INCOME_ACCOUNT_CODE, 'credit')).toBeCloseTo(
        1000,
        2,
      );
      expect(sumAccount(cashLegs, UNEARNED_REVENUE_CODE, 'credit')).toBeCloseTo(
        500,
        2,
      );
      expectBalanced(cashLegs);
    });
  });

  describe('Customer opening balance as an open item', () => {
    let customerId: number;
    let firstPaymentId: number;
    let laterPaymentId: number;

    const cashLegsOf = async (paymentId: number) =>
      (await fetchLegs('PaymentReceive', paymentId, 'cash')).filter(
        (leg) => leg.basis === 'cash',
      );

    const newPageEntries = async () =>
      (
        await request(app.getHttpServer())
          .get('/payments-received/new-page/entries')
          .query({ customerId })
          .set(authHeaders())
          .expect(200)
      ).body;

    beforeAll(async () => {
      // Plan example: opening balance 300, invoice 100, payment 550.
      customerId = await createCustomerWithOpeningBalance(300);
      const invoiceId = await createInvoice(customerId, 100);

      firstPaymentId = await createPayment(
        customerId,
        550,
        [openingBalanceEntry(300), { invoiceId, paymentAmount: 100 }],
        day(5),
      );
    });

    it('lists the unpaid opening balance first on the new payment page', async () => {
      const otherCustomerId = await createCustomerWithOpeningBalance(120);
      const entries = (
        await request(app.getHttpServer())
          .get('/payments-received/new-page/entries')
          .query({ customerId: otherCustomerId })
          .set(authHeaders())
          .expect(200)
      ).body;

      expect(entries[0]).toMatchObject({
        entry_type: 'opening_balance',
        invoice_id: null,
        due_amount: 120,
      });
    });

    it('credits Other Income with the opening balance line, only the true excess is unearned', async () => {
      const legs = await cashLegsOf(firstPaymentId);

      expect(sumAccount(legs, BANK_ACCOUNT_CODE, 'debit')).toBeCloseTo(550, 2);
      expect(sumAccount(legs, OTHER_INCOME_CODE, 'credit')).toBeCloseTo(300, 2);
      expect(sumAccount(legs, INCOME_ACCOUNT_CODE, 'credit')).toBeCloseTo(
        100,
        2,
      );
      expect(sumAccount(legs, UNEARNED_REVENUE_CODE, 'credit')).toBeCloseTo(
        150,
        2,
      );
      expectBalanced(legs);
    });

    it('keeps the accrual side unchanged (bank / receivable)', async () => {
      const legs = await fetchLegs('PaymentReceive', firstPaymentId, 'accrual');

      expect(sumAccount(legs, BANK_ACCOUNT_CODE, 'debit')).toBeCloseTo(550, 2);
      expectBalanced(legs);
    });

    it('shows no opening balance row once it is fully paid', async () => {
      const entries = await newPageEntries();

      expect(
        entries.filter((e) => e.entry_type === 'opening_balance'),
      ).toHaveLength(0);
    });

    it('rejects paying more than the opening balance due', async () => {
      const res = await request(app.getHttpServer())
        .post('/payments-received')
        .set(authHeaders())
        .send(paymentPayload(customerId, 50, [openingBalanceEntry(50)]))
        .expect(400);

      expect(JSON.stringify(res.body)).toContain(
        'OPENING_BALANCE_PAYMENT_EXCEEDS_DUE',
      );
    });

    it('rejects an opening balance below what payments already paid', async () => {
      const res = await request(app.getHttpServer())
        .put(`/customers/${customerId}/opening-balance`)
        .set(authHeaders())
        .send({
          openingBalance: 200,
          openingBalanceAt: '2034-01-01',
          openingBalanceExchangeRate: 1,
        })
        .expect(400);

      expect(JSON.stringify(res.body)).toContain('OPENING_BALANCE_BELOW_PAID');
    });

    it('rejects a customer payment with no line, and reopens only what a deleted payment paid', async () => {
      laterPaymentId = await createPayment(customerId, 200, [], day(7)).catch(
        () => null,
      );
      // A customer payment needs an invoice or the opening balance line.
      expect(laterPaymentId).toBeNull();

      await request(app.getHttpServer())
        .delete(`/payments-received/${firstPaymentId}`)
        .set(authHeaders())
        .expect(200);

      const entries = await newPageEntries();
      expect(entries[0]).toMatchObject({
        entry_type: 'opening_balance',
        due_amount: 300,
      });
    });

    it('pays part of the opening balance without an invoice', async () => {
      const paymentId = await createPayment(
        customerId,
        100,
        [openingBalanceEntry(100)],
        day(8),
      );
      const legs = await cashLegsOf(paymentId);

      expect(sumAccount(legs, OTHER_INCOME_CODE, 'credit')).toBeCloseTo(100, 2);
      expect(sumAccount(legs, UNEARNED_REVENUE_CODE, 'credit')).toBeCloseTo(
        0,
        2,
      );
      expect((await newPageEntries())[0].due_amount).toBeCloseTo(200, 2);
    });
  });

  describe('Editing a paid invoice', () => {
    it("rewrites the payment's cash income lines", async () => {
      const customerId = await createCustomer(baseCurrency);
      const invoiceId = await createInvoice(customerId, 1000);
      const paymentId = await createPayment(customerId, 500, [
        { invoiceId, paymentAmount: 500 },
      ]);
      const before = await fetchLegs('PaymentReceive', paymentId, 'cash');
      expect(sumAccount(before, INCOME_ACCOUNT_CODE, 'credit')).toBeCloseTo(
        500,
        2,
      );

      // Discount 100: the payment now covers 500/900 of the invoice.
      await request(app.getHttpServer())
        .put(`/sale-invoices/${invoiceId}`)
        .set(authHeaders())
        .send(
          invoicePayload(customerId, 1000, {
            discount: 100,
            discountType: 'amount',
          }),
        )
        .expect(200);

      const after = (
        await fetchLegs('PaymentReceive', paymentId, 'cash')
      ).filter((leg) => leg.basis === 'cash');
      expect(sumAccount(after, INCOME_ACCOUNT_CODE, 'credit')).toBeCloseTo(
        555.556,
        2,
      );
      expect(sumAccount(after, DISCOUNT_CODE, 'debit')).toBeCloseTo(55.556, 2);
      expectBalanced(after);
    });
  });

  describe('Vendor payments', () => {
    let vendorId: number;
    let expenseAccountCode: string;

    beforeAll(async () => {
      vendorId = await createVendor(baseCurrency);
      expenseAccountCode = '40002';
    });

    it("rewrites the payment's cash expense lines when the paid bill is edited", async () => {
      const billId = await createBill(vendorId, 1000);
      const res = await request(app.getHttpServer())
        .post('/bill-payments')
        .set(authHeaders())
        .send(
          billPaymentPayload(vendorId, 500, [{ billId, paymentAmount: 500 }]),
        )
        .expect(201);
      const paymentId = res.body.id;

      const before = await fetchLegs('BillPayment', paymentId, 'cash');
      expect(sumAccount(before, expenseAccountCode, 'debit')).toBeCloseTo(
        500,
        2,
      );

      await request(app.getHttpServer())
        .put(`/bills/${billId}`)
        .set(authHeaders())
        .send(
          billPayload(vendorId, 1000, {
            discount: 100,
            discountType: 'amount',
          }),
        )
        .expect(200);

      const after = (await fetchLegs('BillPayment', paymentId, 'cash')).filter(
        (leg) => leg.basis === 'cash',
      );
      expect(sumAccount(after, expenseAccountCode, 'debit')).toBeCloseTo(
        555.556,
        2,
      );
      expect(sumAccount(after, PURCHASE_DISCOUNT_CODE, 'credit')).toBeCloseTo(
        55.556,
        2,
      );
      expectBalanced(after);
    });

    it('records the unapplied amount as prepaid expenses on the cash basis', async () => {
      const billId = await createBill(vendorId, 1000);
      const res = await request(app.getHttpServer())
        .post('/bill-payments')
        .set(authHeaders())
        .send(
          billPaymentPayload(vendorId, 1300, [{ billId, paymentAmount: 1000 }]),
        )
        .expect(201);

      const legs = (await fetchLegs('BillPayment', res.body.id, 'cash')).filter(
        (leg) => leg.basis === 'cash',
      );
      expect(sumAccount(legs, BANK_ACCOUNT_CODE, 'credit')).toBeCloseTo(
        1300,
        2,
      );
      expect(sumAccount(legs, PREPAID_EXPENSES_CODE, 'debit')).toBeCloseTo(
        300,
        2,
      );
      expect(sumAccount(legs, OTHER_EXPENSES_CODE, 'debit')).toBeCloseTo(0, 2);
      expectBalanced(legs);
    });

    it('debits Other Expenses with the vendor opening balance line, only the true excess is prepaid', async () => {
      // Plan example: opening balance 400, bill 500, payment 1,000.
      const vendorRes = await request(app.getHttpServer())
        .post('/vendors')
        .set(authHeaders())
        .send({
          displayName: `Basis OB Vendor ${Date.now()}-${faker.string.alphanumeric({ length: 4 })}`,
          currencyCode: baseCurrency,
          openingBalance: 400,
          openingBalanceAt: '2034-01-01',
          openingBalanceExchangeRate: 1,
        })
        .expect(201);
      const obVendorId = vendorRes.body.id;
      const billId = await createBill(obVendorId, 500);

      const entriesRes = await request(app.getHttpServer())
        .get('/bill-payments/new-page/entries')
        .query({ vendorId: obVendorId })
        .set(authHeaders())
        .expect(200);
      expect(entriesRes.body[0]).toMatchObject({
        entry_type: 'opening_balance',
        due_amount: 400,
      });

      const res = await request(app.getHttpServer())
        .post('/bill-payments')
        .set(authHeaders())
        .send(
          billPaymentPayload(obVendorId, 1000, [
            { entryType: 'opening_balance', paymentAmount: 400 },
            { billId, paymentAmount: 500 },
          ]),
        )
        .expect(201);

      const legs = (await fetchLegs('BillPayment', res.body.id, 'cash')).filter(
        (leg) => leg.basis === 'cash',
      );
      expect(sumAccount(legs, BANK_ACCOUNT_CODE, 'credit')).toBeCloseTo(
        1000,
        2,
      );
      expect(sumAccount(legs, OTHER_EXPENSES_CODE, 'debit')).toBeCloseTo(
        400,
        2,
      );
      expect(sumAccount(legs, expenseAccountCode, 'debit')).toBeCloseTo(500, 2);
      expect(sumAccount(legs, PREPAID_EXPENSES_CODE, 'debit')).toBeCloseTo(
        100,
        2,
      );
      expectBalanced(legs);
    });

    it('blocks editing a bill whose payment is in a locked period', async () => {
      // The bill is after the lock date, its payment is inside it.
      const billRes = await request(app.getHttpServer())
        .post('/bills')
        .set(authHeaders())
        .send(
          billPayload(vendorId, 1000, { billDate: day(8), dueDate: day(8) }),
        )
        .expect(201);
      const billId = billRes.body.id;
      await request(app.getHttpServer())
        .post('/bill-payments')
        .set(authHeaders())
        .send(
          billPaymentPayload(vendorId, 1000, [{ billId, paymentAmount: 1000 }]),
        )
        .expect(201);

      await request(app.getHttpServer())
        .put('/transactions-locking/lock')
        .set(authHeaders())
        .send({ module: 'all', lockToDate: day(6), reason: 'e2e lock' })
        .expect(200);
      try {
        const res = await request(app.getHttpServer())
          .put(`/bills/${billId}`)
          .set(authHeaders())
          .send(
            billPayload(vendorId, 1000, {
              billDate: day(8),
              dueDate: day(8),
              discount: 100,
              discountType: 'amount',
            }),
          )
          .expect(400);

        expect(JSON.stringify(res.body)).toContain(
          'LINKED_TRANSACTIONS_DATE_LOCKED',
        );
      } finally {
        await cancelTransactionsLock();
      }
    });

    it('rejects a payment that applies more than the amount paid', async () => {
      const billId = await createBill(vendorId, 1000);
      const res = await request(app.getHttpServer())
        .post('/bill-payments')
        .set(authHeaders())
        .send(
          billPaymentPayload(vendorId, 500, [{ billId, paymentAmount: 1000 }]),
        )
        .expect(400);

      expect(JSON.stringify(res.body)).toContain(
        'PAYMENT_ENTRIES_EXCEED_AMOUNT',
      );
    });
  });

  describe('Bank register', () => {
    it('shows one row per payment', async () => {
      const customerId = await createCustomer(baseCurrency);
      const invoiceId = await createInvoice(customerId, 1000);
      const paymentId = await createPayment(customerId, 1200, [
        { invoiceId, paymentAmount: 1000 },
      ]);

      const res = await request(app.getHttpServer())
        .get('/banking/transactions')
        .query({ accountId: bankAccountId, page: 1, pageSize: 1000 })
        .set(authHeaders())
        .expect(200);

      const rows = (res.body.transactions ?? res.body.data ?? []).filter(
        (row) =>
          (row.reference_type ?? row.referenceType) === 'PaymentReceive' &&
          Number(row.reference_id ?? row.referenceId) === paymentId,
      );
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].deposit)).toBeCloseTo(1200, 2);
    });
  });
});
