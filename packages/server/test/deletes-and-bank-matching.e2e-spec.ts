import { faker } from '@faker-js/faker';
import { ConfigService } from '@nestjs/config';
import { getQueueToken } from '@nestjs/bullmq';
import { ClsService } from 'nestjs-cls';
import { Queue } from 'bullmq';
import { knex as knexFactory, Knex } from 'knex';
import { knexSnakeCaseMappers } from 'objection';
import { app } from './init-app-test';
import { as, Company, createCompany } from './_utils/security';
import { DeleteBankRuleService } from '../src/modules/BankRules/commands/DeleteBankRule.service';
import { RecognizeUncategorizedTransactionsQueue } from '../src/modules/BankingTranasctionsRegonize/_types';
import { CreatePaymentReceiveStripePayment } from '../src/modules/StripePayment/CreatePaymentReceivedStripePayment';
import { ServiceError } from '../src/modules/Items/ServiceError';

/**
 * Package 2 (round 3): deletes, undo and bank matching.
 * - B1: a written-off invoice can't be deleted until the write-off is cancelled.
 * - B2: the expense or bill a landed cost came from can't be deleted, and its
 *   landed-cost line can't be removed or reduced below what was allocated.
 * - B3: a deposit made from a bank line can't be deleted; uncategorize instead.
 * - B4: unmatching deletes the payment the match created.
 * - B5: matching a foreign-currency invoice or bill needs an exchange rate.
 * - B6: deleting an account with no bank rules keeps every rule suggestion.
 * - B7: a Stripe payment works when the clearing account must be created.
 * - B8: the bank-rules job is queued only once the rule is saved.
 * - B9: a failed bank-rule delete stops the account delete.
 * Runs in a new company, so nothing shared is touched.
 */
jest.retryTimes(0);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const DATE = '2026-03-10';

describe('Deletes, undo and bank matching (e2e)', () => {
  let company: Company;
  let db: Knex;
  const api = () => as(app, company.owner, company.organizationId);
  const tag = faker.string.alphanumeric(6).toLowerCase();
  const uid = () => faker.string.alphanumeric(8).toUpperCase();

  let accounts: {
    bank: number;
    income: number;
    expense: number;
    cogs: number;
    inventory: number;
    equity: number;
    payable: number;
  };
  let customerId: number;
  let vendorId: number;
  let serviceItemId: number;
  let inventoryItemId: number;

  const ok = (res: any, status = [200, 201]) => {
    if (!status.includes(res.status)) {
      throw new Error(`HTTP ${res.status}: ${JSON.stringify(res.body)}`);
    }
    return res;
  };
  const errorType = (res: any) => res.body?.errors?.[0]?.type;
  const errorMessage = (res: any) => res.body?.errors?.[0]?.message;

  const createAccount = async (attrs: Record<string, any>) =>
    ok(
      await api()
        .post('/accounts')
        .send({
          name: `P2 ${attrs.accountType} ${uid()}`,
          code: uid().slice(0, 6),
          ...attrs,
        }),
    ).body.id as number;

  const createInvoice = async (
    amount: number,
    extra: Record<string, any> = {},
  ) =>
    ok(
      await api()
        .post('/sale-invoices')
        .send({
          customerId,
          invoiceDate: DATE,
          dueDate: '2026-03-31',
          invoiceNo: `P2-${uid()}`,
          delivered: true,
          entries: [
            { index: 1, itemId: serviceItemId, quantity: 1, rate: amount },
          ],
          ...extra,
        }),
    ).body.id as number;

  const postBill = (
    entries: Array<Record<string, any>>,
    extra: Record<string, any> = {},
  ) =>
    api()
      .post('/bills')
      .send({
        vendorId,
        billDate: DATE,
        dueDate: '2026-03-31',
        billNumber: `P2B-${uid()}`,
        open: true,
        entries: entries.map((e, i) => ({ index: i + 1, quantity: 1, ...e })),
        ...extra,
      });

  /** Inserts a bank-feed line, as the bank feed would. */
  const createBankLine = async (
    accountId: number,
    amount: number,
    description = `P2 line ${uid()}`,
    currencyCode = 'USD',
  ) => {
    const [id] = await db('uncategorized_cashflow_transactions').insert({
      date: DATE,
      accountId,
      amount,
      currencyCode,
      description,
      categorized: false,
    });
    await db('accounts')
      .where({ id: accountId })
      .increment('uncategorizedTransactions', 1);
    return id as number;
  };

  const ledger = (referenceType: string, referenceId: number) =>
    db('accounts_transactions').where({ referenceType, referenceId });

  const bankNet = async (
    accountId: number,
    referenceType: string,
    ids: number[],
  ) => {
    const rows = await db('accounts_transactions')
      .where({ accountId, referenceType })
      // Entries kept for both bases have no basis; skip the cash-basis copy.
      .where((q) => q.where('basis', 'accrual').orWhereNull('basis'))
      .whereIn('referenceId', ids.length ? ids : [0]);
    return rows.reduce((sum, r) => sum + Number(r.debit) - Number(r.credit), 0);
  };

  beforeAll(async () => {
    company = await createCompany(app, 'p2del');
    const config = app.get(ConfigService).get('tenantDatabase');
    db = knexFactory({
      client: config.client,
      connection: {
        host: config.host,
        port: Number(config.port),
        user: config.user,
        password: config.password,
        database: `${config.dbNamePrefix}${company.organizationId}`,
        charset: 'utf8',
      },
      pool: { min: 0, max: 1 },
      ...knexSnakeCaseMappers({ upperCase: true }),
    });
    const byType = async (type: string) =>
      (await db('accounts').where('accountType', type).first('id')).id;
    accounts = {
      bank: await byType('bank'),
      income: await byType('income'),
      expense: await byType('expense'),
      cogs: await byType('cost-of-goods-sold'),
      inventory: await byType('inventory'),
      equity: await byType('equity'),
      payable: await byType('accounts-payable'),
    };

    customerId = ok(
      await api()
        .post('/customers')
        .send({
          displayName: `P2 customer ${tag}`,
          customerType: 'business',
          currencyCode: 'USD',
        }),
    ).body.id;
    vendorId = ok(
      await api()
        .post('/vendors')
        .send({ displayName: `P2 vendor ${tag}`, currencyCode: 'USD' }),
    ).body.id;
    serviceItemId = ok(
      await api()
        .post('/items')
        .send({
          name: `P2 service ${tag}`,
          type: 'service',
          sellable: true,
          purchasable: true,
          sellAccountId: accounts.income,
          costAccountId: accounts.expense,
          sellPrice: 100,
          costPrice: 100,
        }),
    ).body.id;
    inventoryItemId = ok(
      await api()
        .post('/items')
        .send({
          name: `P2 stock ${tag}`,
          type: 'inventory',
          sellable: true,
          purchasable: true,
          sellAccountId: accounts.income,
          costAccountId: accounts.cogs,
          inventoryAccountId: accounts.inventory,
          sellPrice: 50,
          costPrice: 20,
        }),
    ).body.id;
  }, 300000);

  afterAll(async () => {
    jest.restoreAllMocks();
    await db?.destroy();
  });

  // -------------------------------------------------------------------
  describe('B1: deleting a written-off invoice', () => {
    it('is refused until the write-off is cancelled', async () => {
      const invoiceId = await createInvoice(1000);
      ok(
        await api().post(`/sale-invoices/${invoiceId}/writeoff`).send({
          expenseAccountId: accounts.expense,
          date: DATE,
          reason: 'Bad debt',
        }),
      );
      expect(
        (await ledger('InvoiceWriteOff', invoiceId)).length,
      ).toBeGreaterThan(0);

      const refused = await api().delete(`/sale-invoices/${invoiceId}`);
      expect(refused.status).toBe(400);
      expect(errorType(refused)).toBe('SALE_INVOICE_IS_WRITTEN_OFF');
      expect(errorMessage(refused)).toMatch(/Cancel the write-off first/);
      expect(await db('sales_invoices').where({ id: invoiceId })).toHaveLength(
        1,
      );

      // Bulk delete lists it as not deletable.
      const bulk = ok(
        await api()
          .post('/sale-invoices/validate-bulk-delete')
          .send({ ids: [invoiceId] }),
      );
      const bulkBody = bulk.body.data ?? bulk.body;
      expect(bulkBody.nonDeletableIds ?? bulkBody.non_deletable_ids).toEqual([
        invoiceId,
      ]);

      ok(await api().post(`/sale-invoices/${invoiceId}/cancel-writeoff`));
      ok(await api().delete(`/sale-invoices/${invoiceId}`));

      expect(await ledger('InvoiceWriteOff', invoiceId)).toEqual([]);
      expect(await ledger('SaleInvoice', invoiceId)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------
  describe('B2: the source of a landed cost', () => {
    let targetBillId: number;
    let targetEntryId: number;

    const allocate = (
      transactionType: 'Bill' | 'Expense',
      transactionId: number,
      transactionEntryId: number,
      cost: number,
    ) =>
      api()
        .post(`/landed-cost/bills/${targetBillId}/allocate`)
        .send({
          transactionId,
          transactionType,
          transactionEntryId,
          allocationMethod: 'value',
          description: 'Freight',
          items: [{ entryId: targetEntryId, cost }],
        });

    const expenseBody = (amount: number, id?: number) => ({
      exchangeRate: 1,
      description: 'Freight',
      paymentAccountId: accounts.bank,
      referenceNo: uid(),
      publish: true,
      paymentDate: DATE,
      categories: [
        {
          ...(id ? { id } : {}),
          index: 1,
          expenseAccountId: accounts.expense,
          amount,
          landedCost: true,
        },
      ],
    });

    beforeAll(async () => {
      ok(
        await api()
          .put('/settings')
          .send({
            options: [{ group: 'features', key: 'landed_cost', value: 1 }],
          }),
      );
      const target = ok(
        await postBill([{ itemId: inventoryItemId, quantity: 10, rate: 100 }]),
      );
      targetBillId = target.body.id;
      targetEntryId = (
        await db('items_entries')
          .where({ referenceType: 'Bill', referenceId: targetBillId })
          .first('id')
      ).id;
    });

    it('expense source: delete, remove and reduce are refused until the landed cost is removed', async () => {
      const expenseId = ok(await api().post('/expenses').send(expenseBody(200)))
        .body.id;
      const categoryId = (
        await db('expense_transaction_categories')
          .where({ expenseId })
          .first('id')
      ).id;
      const landedCostId = ok(
        await allocate('Expense', expenseId, categoryId, 200),
      ).body.id;
      const bill = await db('bills').where({ id: targetBillId }).first();

      // Delete.
      const del = await api().delete(`/expenses/${expenseId}`);
      expect(del.status).toBe(400);
      expect(errorType(del)).toBe('EXPENSE_HAS_ASSOCIATED_LANDED_COST');
      expect(errorMessage(del)).toContain(bill.billNumber);

      // Remove the line (a new line instead of the landed-cost one).
      const removed = await api()
        .put(`/expenses/${expenseId}`)
        .send({
          ...expenseBody(200),
          categories: [
            { index: 1, expenseAccountId: accounts.expense, amount: 200 },
          ],
        });
      expect(removed.status).toBe(400);
      expect(errorType(removed)).toBe(
        'ENTRIES_ALLOCATED_COST_COULD_NOT_DELETED',
      );

      // Reduce the line below what was allocated.
      const reduced = await api()
        .put(`/expenses/${expenseId}`)
        .send(expenseBody(50, categoryId));
      expect(reduced.status).toBe(400);
      expect(errorType(reduced)).toBe(
        'LOCATED_COST_ENTRIES_SHOULD_BIGGE_THAN_NEW_ENTRIES',
      );

      // Raising it keeps the line and what was allocated from it.
      ok(
        await api()
          .put(`/expenses/${expenseId}`)
          .send(expenseBody(250, categoryId)),
      );
      const kept = await db('expense_transaction_categories')
        .where({ id: categoryId })
        .first();
      expect(Number(kept.allocatedCostAmount)).toBe(200);
      expect(Number(kept.amount)).toBe(250);

      // Remove the landed cost: then everything is allowed.
      ok(await api().delete(`/landed-cost/${landedCostId}`));
      ok(await api().delete(`/expenses/${expenseId}`));
      expect(await ledger('Expense', expenseId)).toEqual([]);
      expect(await ledger('LandedCost', landedCostId)).toEqual([]);
    });

    it('bill source: delete, remove and reduce are refused until the landed cost is removed', async () => {
      // The landed-cost line rule is changing (Q9, Package 4): try a service
      // line first and fall back to an inventory line.
      let source = await postBill([
        { itemId: serviceItemId, rate: 300, landedCost: true },
      ]);
      let sourceItemId = serviceItemId;
      if (
        source.status === 400 &&
        errorType(source) === 'LANDED_COST_ENTRIES_SHOULD_BE_INVENTORY_ITEMS'
      ) {
        source = await postBill([
          { itemId: inventoryItemId, rate: 300, landedCost: true },
        ]);
        sourceItemId = inventoryItemId;
      }
      const sourceBillId = ok(source).body.id;
      const sourceEntryId = (
        await db('items_entries')
          .where({ referenceType: 'Bill', referenceId: sourceBillId })
          .first('id')
      ).id;
      const landedCostId = ok(
        await allocate('Bill', sourceBillId, sourceEntryId, 200),
      ).body.id;
      const target = await db('bills').where({ id: targetBillId }).first();
      const editBody = (entries: Array<Record<string, any>>) => {
        return {
          vendorId,
          billDate: DATE,
          dueDate: '2026-03-31',
          billNumber: `P2B-${uid()}`,
          open: true,
          entries: entries.map((e, i) => ({ index: i + 1, quantity: 1, ...e })),
        };
      };

      // Delete.
      const del = await api().delete(`/bills/${sourceBillId}`);
      expect(del.status).toBe(400);
      expect(errorType(del)).toBe('BILL_USED_AS_LANDED_COST');
      expect(errorMessage(del)).toContain(target.billNumber);

      // Remove the line.
      const removed = await api()
        .put(`/bills/${sourceBillId}`)
        .send(editBody([{ itemId: sourceItemId, rate: 300 }]));
      expect(removed.status).toBe(400);
      expect(errorType(removed)).toBe(
        'ENTRIES_ALLOCATED_COST_COULD_NOT_DELETED',
      );

      // Reduce it below what was allocated.
      const reduced = await api()
        .put(`/bills/${sourceBillId}`)
        .send(
          editBody([
            {
              id: sourceEntryId,
              itemId: sourceItemId,
              rate: 150,
              landedCost: true,
            },
          ]),
        );
      expect(reduced.status).toBe(400);
      expect(errorType(reduced)).toBe(
        'LOCATED_COST_ENTRIES_SHOULD_BIGGE_THAN_NEW_ENTRIES',
      );

      // Reducing it to no less than what was allocated keeps the line.
      ok(
        await api()
          .put(`/bills/${sourceBillId}`)
          .send(
            editBody([
              {
                id: sourceEntryId,
                itemId: sourceItemId,
                rate: 250,
                landedCost: true,
              },
            ]),
          ),
      );
      const kept = await db('items_entries')
        .where({ id: sourceEntryId })
        .first();
      expect(Number(kept.allocatedCostAmount)).toBe(200);
      expect(Number(kept.rate)).toBe(250);

      ok(await api().delete(`/landed-cost/${landedCostId}`));
      ok(await api().delete(`/bills/${sourceBillId}`));
      expect(await ledger('Bill', sourceBillId)).toEqual([]);
      expect(await ledger('LandedCost', landedCostId)).toEqual([]);
    });
  });

  // -------------------------------------------------------------------
  describe('B3: deleting a deposit made from a bank line', () => {
    const categorize = (lineId: number, description: string) =>
      api()
        .post('/banking/categorize')
        .send({
          uncategorizedTransactionIds: [lineId],
          date: DATE,
          transactionType: 'OwnerContribution',
          creditAccountId: accounts.equity,
          description,
        });

    it('is refused; uncategorizing removes it and frees the line', async () => {
      const lineId = await createBankLine(accounts.bank, 500);
      const description = `P2 deposit ${uid()}`;
      ok(await categorize(lineId, description));
      const [deposit] = await db('cashflow_transactions').where({
        description,
      });
      expect(deposit).toBeDefined();

      const refused = await api().delete(`/banking/transactions/${deposit.id}`);
      expect(refused.status).toBe(400);
      expect(errorType(refused)).toBe(
        'CANNOT_DELETE_TRANSACTION_CONVERTED_FROM_UNCATEGORIZED',
      );
      expect(
        await db('cashflow_transactions').where({ id: deposit.id }),
      ).toHaveLength(1);
      expect(
        (await ledger('CashflowTransaction', deposit.id)).length,
      ).toBeGreaterThan(0);

      ok(await api().delete(`/banking/categorize/${lineId}`));
      expect(
        await db('cashflow_transactions').where({ id: deposit.id }),
      ).toEqual([]);
      const line = await db('uncategorized_cashflow_transactions')
        .where({ id: lineId })
        .first();
      expect(Number(line.categorized)).toBe(0);
      expect(line.categorizeRefId).toBeNull();

      // Categorize again: one posting.
      ok(await categorize(lineId, description));
      const again = await db('cashflow_transactions').where({ description });
      expect(again).toHaveLength(1);
      expect(
        await bankNet(accounts.bank, 'CashflowTransaction', [
          deposit.id,
          again[0].id,
        ]),
      ).toBe(500);
    });
  });

  // -------------------------------------------------------------------
  describe('B4: unmatching', () => {
    const match = (
      lineId: number,
      referenceType: string,
      referenceId: number,
      extra = {},
    ) =>
      api()
        .post('/banking/matching/match')
        .send({
          uncategorizedTransactions: [lineId],
          matchedTransactions: [{ referenceType, referenceId, ...extra }],
        });
    const matchesOf = (lineId: number) =>
      db('matched_bank_transactions').where({
        uncategorizedTransactionId: lineId,
      });

    it('an invoice match: the payment it created is deleted', async () => {
      const invoiceId = await createInvoice(300);
      const lineId = await createBankLine(accounts.bank, 300);
      ok(await match(lineId, 'SaleInvoice', invoiceId));

      const paymentMatch = (await matchesOf(lineId)).find(
        (m) => m.referenceType === 'PaymentReceive',
      );
      expect(paymentMatch).toBeDefined();
      const paymentId = paymentMatch.referenceId;
      expect(await bankNet(accounts.bank, 'PaymentReceive', [paymentId])).toBe(
        300,
      );

      ok(await api().patch(`/banking/matching/unmatch/${lineId}`));

      expect(await matchesOf(lineId)).toEqual([]);
      expect(await db('payment_receives').where({ id: paymentId })).toEqual([]);
      expect(await ledger('PaymentReceive', paymentId)).toEqual([]);
      const invoice = await db('sales_invoices')
        .where({ id: invoiceId })
        .first();
      expect(Number(invoice.paymentAmount)).toBe(0);
      expect(await bankNet(accounts.bank, 'PaymentReceive', [paymentId])).toBe(
        0,
      );
    });

    it('a bill match: the payment it created is deleted', async () => {
      const billId = ok(await postBill([{ itemId: serviceItemId, rate: 300 }]))
        .body.id;
      const lineId = await createBankLine(accounts.bank, -300);
      ok(await match(lineId, 'Bill', billId));

      const paymentMatch = (await matchesOf(lineId)).find(
        (m) => m.referenceType === 'BillPayment',
      );
      expect(paymentMatch).toBeDefined();
      const paymentId = paymentMatch.referenceId;
      expect(await bankNet(accounts.bank, 'BillPayment', [paymentId])).toBe(
        -300,
      );

      ok(await api().patch(`/banking/matching/unmatch/${lineId}`));

      expect(await db('bills_payments').where({ id: paymentId })).toEqual([]);
      expect(await ledger('BillPayment', paymentId)).toEqual([]);
      const bill = await db('bills').where({ id: billId }).first();
      expect(Number(bill.paymentAmount)).toBe(0);
    });

    it('an expense match: the expense stays', async () => {
      const expenseId = ok(
        await api()
          .post('/expenses')
          .send({
            exchangeRate: 1,
            paymentAccountId: accounts.bank,
            referenceNo: uid(),
            publish: true,
            paymentDate: DATE,
            categories: [
              { index: 1, expenseAccountId: accounts.expense, amount: 120 },
            ],
          }),
      ).body.id;
      const lineId = await createBankLine(accounts.bank, -120);
      ok(await match(lineId, 'Expense', expenseId));
      ok(await api().patch(`/banking/matching/unmatch/${lineId}`));

      expect(await matchesOf(lineId)).toEqual([]);
      expect(
        await db('expenses_transactions').where({ id: expenseId }),
      ).toHaveLength(1);
      expect(await bankNet(accounts.bank, 'Expense', [expenseId])).toBe(-120);
    });
  });

  // -------------------------------------------------------------------
  describe('B5: matching a foreign-currency invoice or bill', () => {
    let eurBank: number;
    let eurCustomerId: number;
    let eurVendorId: number;

    const match = (
      lineId: number,
      referenceType: string,
      referenceId: number,
      extra = {},
    ) =>
      api()
        .post('/banking/matching/match')
        .send({
          uncategorizedTransactions: [lineId],
          matchedTransactions: [{ referenceType, referenceId, ...extra }],
        });

    beforeAll(async () => {
      const currency = await api()
        .post('/currencies')
        .send({ currencyName: 'Euro', currencyCode: 'EUR', currencySign: '€' });
      expect([200, 201, 400]).toContain(currency.status);
      eurBank = await createAccount({
        accountType: 'bank',
        currencyCode: 'EUR',
      });
      eurCustomerId = ok(
        await api()
          .post('/customers')
          .send({
            displayName: `P2 EUR customer ${tag}`,
            customerType: 'business',
            currencyCode: 'EUR',
          }),
      ).body.id;
      eurVendorId = ok(
        await api()
          .post('/vendors')
          .send({ displayName: `P2 EUR vendor ${tag}`, currencyCode: 'EUR' }),
      ).body.id;
    });

    it('an invoice: refused without a rate, and uses the given rate', async () => {
      const invoiceId = await createInvoice(1000, {
        customerId: eurCustomerId,
        exchangeRate: 1.1,
      });
      const lineId = await createBankLine(eurBank, 1000, undefined, 'EUR');

      const refused = await match(lineId, 'SaleInvoice', invoiceId);
      expect(refused.status).toBe(400);
      expect(errorType(refused)).toBe('EXCHANGE_RATE_REQUIRED');
      expect(
        await db('matched_bank_transactions').where({
          uncategorizedTransactionId: lineId,
        }),
      ).toEqual([]);

      ok(await match(lineId, 'SaleInvoice', invoiceId, { exchangeRate: 1.2 }));
      const paymentMatch = await db('matched_bank_transactions')
        .where({
          uncategorizedTransactionId: lineId,
          referenceType: 'PaymentReceive',
        })
        .first();
      const payment = await db('payment_receives')
        .where({ id: paymentMatch.referenceId })
        .first();
      expect(Number(payment.exchangeRate)).toBe(1.2);
      // The bank gets 1,000 EUR at 1.2 = 1,200 USD.
      expect(
        await bankNet(eurBank, 'PaymentReceive', [payment.id]),
      ).toBeCloseTo(1200, 2);
      const legs = await ledger('PaymentReceive', payment.id);
      const debit = legs.reduce((s, l) => s + Number(l.debit), 0);
      const credit = legs.reduce((s, l) => s + Number(l.credit), 0);
      expect(debit).toBeCloseTo(credit, 2);
    });

    it('a bill: refused without a rate, and uses the given rate', async () => {
      const billId = ok(
        await postBill([{ itemId: serviceItemId, rate: 1000 }], {
          vendorId: eurVendorId,
          exchangeRate: 1.1,
        }),
      ).body.id;
      const lineId = await createBankLine(eurBank, -1000, undefined, 'EUR');

      const refused = await match(lineId, 'Bill', billId);
      expect(refused.status).toBe(400);
      expect(errorType(refused)).toBe('EXCHANGE_RATE_REQUIRED');

      ok(await match(lineId, 'Bill', billId, { exchangeRate: 1.1 }));
      const paymentMatch = await db('matched_bank_transactions')
        .where({
          uncategorizedTransactionId: lineId,
          referenceType: 'BillPayment',
        })
        .first();
      const payment = await db('bills_payments')
        .where({ id: paymentMatch.referenceId })
        .first();
      expect(Number(payment.exchangeRate)).toBe(1.1);
      // The bank pays 1,000 EUR at 1.1 = 1,100 USD; no exchange difference.
      expect(await bankNet(eurBank, 'BillPayment', [payment.id])).toBeCloseTo(
        -1100,
        2,
      );
    });

    it('the match list gives each document its currency and rate', async () => {
      const invoiceId = await createInvoice(700, {
        customerId: eurCustomerId,
        exchangeRate: 1.15,
      });
      const lineId = await createBankLine(eurBank, 700, undefined, 'EUR');
      const res = ok(
        await api()
          .get('/banking/matching/matched')
          .query({ uncategorizedTransactionIds: [lineId] }),
      );
      const all = [
        ...(res.body.perfectMatches ?? res.body.perfect_matches ?? []),
        ...(res.body.possibleMatches ?? res.body.possible_matches ?? []),
      ];
      const found = all.find(
        (m) =>
          (m.referenceType ?? m.reference_type) === 'SaleInvoice' &&
          (m.referenceId ?? m.reference_id) === invoiceId,
      );
      expect(found).toBeDefined();
      expect(found.currencyCode ?? found.currency_code).toBe('EUR');
      expect(found.exchangeRate ?? found.exchange_rate).toBe(1.15);
    });
  });

  // -------------------------------------------------------------------
  describe('B6 and B9: deleting an account and its bank rules', () => {
    const createRule = async (applyIfAccountId: number) =>
      ok(
        await api()
          .post('/banking/rules')
          .send({
            name: `P2 rule ${uid()}`,
            order: 1,
            applyIfAccountId,
            applyIfTransactionType: 'deposit',
            conditions: [
              {
                field: 'description',
                comparator: 'contains',
                value: `nomatch-${uid()}`,
              },
            ],
            assignCategory: 'Deposit',
            assignAccountId: accounts.equity,
          }),
      ).body.id as number;

    /** Marks the line as suggested by the rule, as the rules job would. */
    const recognize = async (lineId: number, bankRuleId: number) => {
      const [id] = await db('recognized_bank_transactions').insert({
        uncategorizedTransactionId: lineId,
        bankRuleId,
        assignedCategory: 'Deposit',
        assignedAccountId: accounts.equity,
      });
      await db('uncategorized_cashflow_transactions')
        .where({ id: lineId })
        .update({ recognizedTransactionId: id });
    };
    const isRecognized = async (lineId: number) =>
      Boolean(
        (
          await db('uncategorized_cashflow_transactions')
            .where({ id: lineId })
            .first()
        )?.recognizedTransactionId,
      );

    it('B6: deleting an account with no rules keeps every suggestion; one with rules only undoes its own', async () => {
      const bankA = await createAccount({ accountType: 'bank' });
      const bankB = await createAccount({ accountType: 'bank' });
      const ruleA = await createRule(bankA);
      const ruleB = await createRule(bankB);
      // Let the rule jobs finish first (they match nothing).
      await sleep(1500);
      const lineA = await createBankLine(bankA, 40);
      const lineB = await createBankLine(bankB, 60);
      await recognize(lineA, ruleA);
      await recognize(lineB, ruleB);

      const plants = await createAccount({ accountType: 'expense' });
      ok(await api().delete(`/accounts/${plants}`));
      expect(await isRecognized(lineA)).toBe(true);
      expect(await isRecognized(lineB)).toBe(true);

      ok(await api().delete(`/accounts/${bankB}`));
      expect(await isRecognized(lineA)).toBe(true);
      expect(await db('bank_rules').where({ id: ruleB })).toEqual([]);
      expect(await db('bank_rules').where({ id: ruleA })).toHaveLength(1);
    });

    it('B9: a failed bank-rule delete refuses the account delete', async () => {
      const bank = await createAccount({ accountType: 'bank' });
      const ruleId = await createRule(bank);
      await sleep(1000);
      const spy = jest
        .spyOn(DeleteBankRuleService.prototype, 'deleteBankRule')
        .mockRejectedValueOnce(
          new ServiceError('P2_RULE_DELETE_FAILED', 'rule delete failed'),
        );
      try {
        const res = await api().delete(`/accounts/${bank}`);
        // The rule-delete error itself, not a later database error.
        expect(res.status).toBe(400);
        expect(errorType(res)).toBe('P2_RULE_DELETE_FAILED');
        expect(spy).toHaveBeenCalled();
      } finally {
        spy.mockRestore();
      }
      expect(await db('accounts').where({ id: bank })).toHaveLength(1);
      expect(await db('bank_rules').where({ id: ruleId })).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------
  describe('B7: a Stripe payment when the clearing account is missing', () => {
    it('creates the clearing account and records the payment', async () => {
      const invoiceId = await createInvoice(80);
      await db('accounts').where({ slug: 'stripe-clearing' }).delete();

      const cls = app.get(ClsService);
      const service = await app.resolve(CreatePaymentReceiveStripePayment);
      await cls.run(async () => {
        cls.set('organizationId', company.organizationId);
        cls.set('userId', company.owner.systemUserId);
        await cls.resolveProxyProviders();
        await service.createPaymentReceived(invoiceId, 80);
      });

      const clearing = await db('accounts')
        .where({ slug: 'stripe-clearing' })
        .first();
      expect(clearing).toBeDefined();
      const invoice = await db('sales_invoices')
        .where({ id: invoiceId })
        .first();
      expect(Number(invoice.paymentAmount)).toBe(80);
      const payment = await db('payment_receives')
        .where({ depositAccountId: clearing.id })
        .first();
      expect(payment).toBeDefined();
    });
  });

  // -------------------------------------------------------------------
  describe('B8: the bank-rules job is queued after the rule is saved', () => {
    it('on create and edit, the queued job sees the saved rule', async () => {
      const queue = app.get<Queue>(
        getQueueToken(RecognizeUncategorizedTransactionsQueue),
      );
      const seen: Array<{ ruleId: number; value: string | null }> = [];
      const original = queue.add.bind(queue);
      const spy = jest
        .spyOn(queue, 'add')
        .mockImplementation(async (name, data: any, opts) => {
          // Reads through a separate connection: only committed rows show.
          const condition = await db('bank_rule_conditions')
            .where({ ruleId: data.ruleId })
            .first();
          seen.push({ ruleId: data.ruleId, value: condition?.value ?? null });
          return original(name, data, opts);
        });
      try {
        const bank = await createAccount({ accountType: 'bank' });
        const ruleId = ok(
          await api()
            .post('/banking/rules')
            .send({
              name: `P2 rule ${uid()}`,
              order: 1,
              applyIfAccountId: bank,
              applyIfTransactionType: 'deposit',
              conditions: [
                {
                  field: 'description',
                  comparator: 'contains',
                  value: 'AMAZON',
                },
              ],
              assignCategory: 'Deposit',
              assignAccountId: accounts.equity,
            }),
        ).body.id;
        await sleep(300);
        ok(
          await api()
            .put(`/banking/rules/${ruleId}`)
            .send({
              name: `P2 rule ${uid()}`,
              order: 1,
              applyIfAccountId: bank,
              applyIfTransactionType: 'deposit',
              conditions: [
                { field: 'description', comparator: 'contains', value: 'AWS' },
              ],
              assignCategory: 'Deposit',
              assignAccountId: accounts.equity,
            }),
        );
        await sleep(300);
        const forRule = seen.filter((s) => s.ruleId === ruleId);
        expect(forRule.map((s) => s.value)).toEqual(['AMAZON', 'AWS']);
      } finally {
        spy.mockRestore();
      }
    });
  });
});
