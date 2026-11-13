import path from 'path';
import { waitForListResponse } from './_invoices';
import { test, expect, type Page } from '@playwright/test';
import { faker } from '@faker-js/faker';
import { readApiAuth, type ApiAuth } from './_api';
import { API_BASE } from './_env';
import { filterInvoicesByNumber, waitForInvoicesList } from './_invoices';
import { waitForExpensesPage } from './_expenses';

// The bank feed has no API to add a line, so the test inserts it the way the
// feed would, through the server's own database client.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const knexFactory = require(
  path.join(__dirname, '../packages/server/node_modules/knex'),
);
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { knexSnakeCaseMappers } = require(
  path.join(__dirname, '../packages/server/node_modules/objection'),
);

/**
 * V1 (B5, D4): matching a bank line to an invoice in another currency asks
 * for the exchange rate, pre-filled (latest provider rate, or the invoice's
 * own rate when the provider has none), and the payment uses that rate.
 */
test.describe('Bank match: exchange rate for a foreign invoice', () => {
  let auth: ApiAuth;
  let db: any;
  let baseCurrency: string;
  let foreignCurrency: string;
  let bankAccountId: number;
  let invoiceId: number;
  let invoiceNo: string;
  let lineId: number;

  const api = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${API_BASE}/api${url}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${auth.accessToken}`,
        'organization-id': auth.organizationId,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(`${method} ${url}: ${res.status} ${JSON.stringify(json)}`);
    }
    return json;
  };

  test.beforeAll(async () => {
    auth = readApiAuth();
    const org = await api('GET', '/organization/current');
    baseCurrency =
      org?.organization?.metadata?.base_currency ??
      org?.organization?.metadata?.baseCurrency ??
      org?.metadata?.base_currency ??
      'AED';
    foreignCurrency = baseCurrency === 'EUR' ? 'GBP' : 'EUR';

    await fetch(`${API_BASE}/api/currencies`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${auth.accessToken}`,
        'organization-id': auth.organizationId,
      },
      body: JSON.stringify({
        currencyName: foreignCurrency,
        currencyCode: foreignCurrency,
        currencySign: foreignCurrency,
      }),
    });
    const tag = faker.string.alphanumeric(6).toUpperCase();
    bankAccountId = (
      await api('POST', '/accounts', {
        name: `V1 ${foreignCurrency} bank ${tag}`,
        code: `V1${tag}`.slice(0, 6),
        accountType: 'bank',
        currencyCode: foreignCurrency,
      })
    ).id;
    const customerId = (
      await api('POST', '/customers', {
        customerType: 'business',
        displayName: `V1 customer ${tag}`,
        currencyCode: foreignCurrency,
      })
    ).id;
    const accounts = await api('GET', '/accounts');
    const list = accounts?.accounts ?? accounts?.data ?? accounts;
    const income = list.find(
      (a: any) => (a.account_type ?? a.accountType) === 'income',
    );
    const itemId = (
      await api('POST', '/items', {
        name: `V1 service ${tag}`,
        type: 'service',
        sellable: true,
        sellAccountId: income.id,
        sellPrice: 100,
      })
    ).id;
    invoiceNo = `V1-${tag}`;
    invoiceId = (
      await api('POST', '/sale-invoices', {
        customerId,
        invoiceDate: '2026-03-10',
        dueDate: '2026-03-31',
        invoiceNo,
        delivered: true,
        exchangeRate: 1.1,
        entries: [{ index: 1, itemId, quantity: 1, rate: 1000 }],
      })
    ).id;

    db = knexFactory({
      client: 'mysql2',
      connection: {
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: `${process.env.TENANT_DB_NAME_PERFIX || 'bigcapital_tenant_'}${auth.organizationId}`,
      },
      pool: { min: 0, max: 1 },
      ...knexSnakeCaseMappers({ upperCase: true }),
    });
    [lineId] = await db('uncategorized_cashflow_transactions').insert({
      date: '2026-03-12',
      accountId: bankAccountId,
      amount: 1000,
      currencyCode: foreignCurrency,
      description: `V1 deposit ${tag}`,
      categorized: false,
    });
    await db('accounts')
      .where({ id: bankAccountId })
      .increment('uncategorizedTransactions', 1);
  });

  test.afterAll(async () => {
    await db?.destroy();
  });

  test('asks for the rate, pre-filled, and the payment uses it', async ({
    page,
  }) => {
    await page.goto(`/cashflow-accounts/${bankAccountId}/transactions`);
    await page.getByText('Uncategorized Transactions').first().click();
    await page.getByText('V1 deposit').first().click();

    // The aside opens; switch to matching.
    await page.getByRole('tab', { name: /match/i }).first().click();
    // Matches read "<type> for <amount>"; this company has one 1,000 invoice.
    await page.getByText(/ for .*1,000\.00/).first().click();

    const rate = page.locator(`input[name="exchangeRates.SaleInvoice-${invoiceId}"]`);
    await expect(rate).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(`1 ${foreignCurrency} =`)).toBeVisible();
    // No provider key in this environment: the invoice's own rate.
    await expect(rate).toHaveValue(/1\.1/, { timeout: 30_000 });

    const matchButton = page.getByRole('button', { name: 'Match', exact: true });
    await rate.fill('');
    await rate.blur();
    await expect(matchButton).toBeDisabled();

    await rate.fill('1.25');
    await rate.blur();
    await expect(matchButton).toBeEnabled();
    await matchButton.click();
    await expect(
      page.getByText('The bank transaction has been matched successfully.'),
    ).toBeVisible({ timeout: 30_000 });

    const paymentMatch = await db('matched_bank_transactions')
      .where({
        uncategorizedTransactionId: lineId,
        referenceType: 'PaymentReceive',
      })
      .first();
    expect(paymentMatch).toBeTruthy();
    const payment = await db('payment_receives')
      .where({ id: paymentMatch.referenceId })
      .first();
    expect(Number(payment.exchangeRate)).toBe(1.25);
  });
});

/** Calls the API as the signed-in test user. */
const apiAs =
  (auth: ApiAuth) => async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${API_BASE}/api${url}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${auth.accessToken}`,
        'organization-id': auth.organizationId,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(`${method} ${url}: ${res.status} ${JSON.stringify(json)}`);
    }
    return json;
  };

const accountOfType = async (
  api: ReturnType<typeof apiAs>,
  type: string,
): Promise<number> => {
  const accounts = await api('GET', '/accounts');
  const list = accounts?.accounts ?? accounts?.data ?? accounts;
  return list.find((a: any) => (a.account_type ?? a.accountType) === type).id;
};

/**
 * Confirms the delete alert that is open on the page.
 */
const confirmDelete = async (page: Page, alertTestId: string) => {
  await expect(page.getByTestId(alertTestId)).toBeVisible();
  await page
    .getByRole('dialog')
    .filter({ has: page.getByTestId(alertTestId) })
    .getByRole('button', { name: 'Delete' })
    .click();
};

/**
 * V2: the new delete refusals show a clear message.
 */
test.describe('Delete refusals show a clear message', () => {
  let api: ReturnType<typeof apiAs>;
  const tag = faker.string.alphanumeric(6).toUpperCase();

  let baseCurrency: string;

  test.beforeAll(async () => {
    api = apiAs(readApiAuth());
    const org = await api('GET', '/organization/current');
    baseCurrency =
      org?.organization?.metadata?.base_currency ??
      org?.organization?.metadata?.baseCurrency ??
      org?.metadata?.base_currency ??
      'AED';
  });

  test('a written-off invoice: "Cancel the write-off first"', async ({
    page,
  }) => {
    const incomeId = await accountOfType(api, 'income');
    const expenseId = await accountOfType(api, 'expense');
    const customerId = (
      await api('POST', '/customers', {
        customerType: 'business',
        displayName: `V2 customer ${tag}`,
        currencyCode: baseCurrency,
      })
    ).id;
    const itemId = (
      await api('POST', '/items', {
        name: `V2 service ${tag}`,
        type: 'service',
        sellable: true,
        sellAccountId: incomeId,
        sellPrice: 100,
      })
    ).id;
    const invoiceNo = `V2-${tag}`;
    const invoiceId = (
      await api('POST', '/sale-invoices', {
        customerId,
        invoiceDate: '2026-03-10',
        dueDate: '2026-03-31',
        invoiceNo,
        delivered: true,
        entries: [{ index: 1, itemId, quantity: 1, rate: 500 }],
      })
    ).id;
    await api('POST', `/sale-invoices/${invoiceId}/writeoff`, {
      expenseAccountId: expenseId,
      date: '2026-03-20',
      reason: 'Bad debt',
    });

    await page.goto('/invoices');
    await waitForInvoicesList(page);
    const row = await filterInvoicesByNumber(page, invoiceNo);
    // The row's right-click menu doesn't open in this environment (the
    // repo's own invoice delete test fails the same way), so delete from
    // the details drawer.
    await row.click();
    await page.getByRole('button', { name: 'Delete', exact: true }).first().click();
    await confirmDelete(page, 'invoice-delete-alert');

    await expect(page.getByText(/Cancel the write-off first/)).toBeVisible({
      timeout: 15_000,
    });
  });

  test('an expense used as landed cost names the bill', async ({ page }) => {
    await api('PUT', '/settings', {
      options: [{ group: 'features', key: 'landed_cost', value: 1 }],
    });
    const accounts = await api('GET', '/accounts');
    const bankId = (accounts?.accounts ?? accounts?.data ?? accounts).find(
      (a: any) =>
        (a.account_type ?? a.accountType) === 'bank' &&
        (a.currency_code ?? a.currencyCode) === baseCurrency,
    ).id;
    const expenseAccountId = await accountOfType(api, 'expense');
    const vendorId = (
      await api('POST', '/vendors', {
        displayName: `V2 vendor ${tag}`,
        currencyCode: baseCurrency,
      })
    ).id;
    const itemId = (
      await api('POST', '/items', {
        name: `V2 stock ${tag}`,
        type: 'inventory',
        sellable: true,
        purchasable: true,
        sellAccountId: await accountOfType(api, 'income'),
        costAccountId: await accountOfType(api, 'cost-of-goods-sold'),
        inventoryAccountId: await accountOfType(api, 'inventory'),
        sellPrice: 50,
        costPrice: 20,
      })
    ).id;
    const billNumber = `V2B-${tag}`;
    const bill = await api('POST', '/bills', {
      vendorId,
      billDate: '2026-03-10',
      dueDate: '2026-03-31',
      billNumber,
      open: true,
      entries: [{ index: 1, itemId, quantity: 10, rate: 100 }],
    });
    const billDetails = await api('GET', `/bills/${bill.id}`);
    const referenceNo = `V2E-${tag}`;
    const expense = await api('POST', '/expenses', {
      exchangeRate: 1,
      paymentAccountId: bankId,
      referenceNo,
      publish: true,
      paymentDate: '2026-03-10',
      categories: [
        { index: 1, expenseAccountId, amount: 200, landedCost: true },
      ],
    });
    const expenseDetails = await api('GET', `/expenses/${expense.id}`);
    await api('POST', `/landed-cost/bills/${bill.id}/allocate`, {
      transactionId: expense.id,
      transactionType: 'Expense',
      transactionEntryId: expenseDetails.categories[0].id,
      allocationMethod: 'value',
      description: 'Freight',
      items: [{ entryId: billDetails.entries[0].id, cost: 200 }],
    });

    await page.goto('/expenses');
    await waitForExpensesPage(page);
    await page.getByRole('button', { name: /filter|filters applied/i }).click();
    // Wait for the filtered list (a new filter replaces the rows).
    const filtered = waitForListResponse(page, '/api/expenses', referenceNo);
    await page.getByPlaceholder('Value').first().fill(referenceNo);
    await filtered;
    const row = page.getByTestId('expense-row').first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await page.keyboard.press('Escape');
    await row.getByText('200.00').click();
    await page.getByRole('button', { name: 'Delete', exact: true }).first().click();
    await confirmDelete(page, 'expense-delete-alert');

    await expect(
      page.getByText(`Used as landed cost on bill ${billNumber}; remove it there first.`),
    ).toBeVisible({ timeout: 15_000 });
  });
});
