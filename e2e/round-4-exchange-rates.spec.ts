import { test, expect, type Page } from '@playwright/test';
import { faker } from '@faker-js/faker';
import { knex as knexFactory, Knex } from 'knex';
import { knexSnakeCaseMappers } from 'objection';
import { authCookies, createOnboardedUser, type OnboardedSession } from './_auth';
import { API_BASE, WEBAPP_BASE } from './_env';
import { selectCustomer, selectEntryItem } from './_invoices';

/**
 * F18 / F19: a foreign-currency form never posts at a silent 1.
 * - It starts at the source document's rate (quick payments and refunds,
 *   see F1 in round-4-fixes.spec.ts), else today's rate from the rate
 *   service, else empty; an empty rate stops the save.
 * - Categorizing a bank line on a foreign-currency account asks for the
 *   rate (it used to send 1, with no field).
 *
 * This environment has no rate-service key, so "today's rate" fails and the
 * field must come up empty, not 1.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const REQUIRED = 'Exchange rate is required for a foreign currency.';

test.describe('F18 / F19: foreign-currency rates are never a silent 1', () => {
  let owner: OnboardedSession;
  let db: Knex;
  const tag = faker.string.alphanumeric(6);
  const customerName = `F18 USD customer ${tag}`;
  const itemName = `F18 service ${tag}`;
  let usdBankId: number;
  let aedBankId: number;

  const api = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(`${API_BASE}/api${url}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${owner.accessToken}`,
        'organization-id': owner.organizationId,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(`${method} ${url}: ${res.status} ${JSON.stringify(json)}`);
    }
    return json;
  };

  const open = async (page: Page, to: string) => {
    await page
      .context()
      .addCookies(authCookies(owner, new URL(WEBAPP_BASE).hostname));
    await page.goto(to);
  };

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    // An AED company (the default) with a USD customer and a USD bank.
    owner = await createOnboardedUser(API_BASE);
    await api('POST', '/currencies', {
      currencyCode: 'USD',
      currencyName: 'US Dollar',
      currencySign: '$',
    }).catch(() => undefined);
    const accountsRes = await api('GET', '/accounts');
    const accounts: any[] = Array.isArray(accountsRes)
      ? accountsRes
      : (accountsRes.accounts ?? accountsRes.data);
    await api('POST', '/items', {
      name: itemName,
      type: 'service',
      sellable: true,
      sellAccountId: accounts.find(
        (a) => (a.accountType ?? a.account_type) === 'income',
      ).id,
      sellPrice: 100,
    });
    await api('POST', '/customers', {
      displayName: customerName,
      customerType: 'business',
      currencyCode: 'USD',
    });
    usdBankId = (
      await api('POST', '/accounts', {
        name: `F19 USD bank ${tag}`,
        code: `U${faker.string.numeric(5)}`,
        accountType: 'bank',
        currencyCode: 'USD',
      })
    ).id;

    db = knexFactory({
      client: 'mysql2',
      connection: {
        host: process.env.DB_HOST || 'localhost',
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: `${process.env.TENANT_DB_NAME_PERFIX || 'bigcapital_tenant_'}${owner.organizationId}`,
      },
      pool: { min: 0, max: 1 },
      ...knexSnakeCaseMappers({ upperCase: true }),
    });
    await db('uncategorized_cashflow_transactions').insert({
      date: '2026-05-12',
      accountId: usdBankId,
      amount: 500,
      currencyCode: 'USD',
      description: `F19 USD deposit ${tag}`,
      categorized: false,
    });
    await db('accounts')
      .where({ id: usdBankId })
      .increment('uncategorizedTransactions', 1);

    // F22: a line on the AED (base currency) bank account.
    aedBankId = (
      await api('POST', '/accounts', {
        name: `F22 AED bank ${tag}`,
        code: `A${faker.string.numeric(5)}`,
        accountType: 'bank',
        currencyCode: 'AED',
      })
    ).id;
    await db('uncategorized_cashflow_transactions').insert({
      date: '2026-05-12',
      accountId: aedBankId,
      amount: 750,
      currencyCode: 'AED',
      description: `F22 AED deposit ${tag}`,
      categorized: false,
    });
    await db('accounts')
      .where({ id: aedBankId })
      .increment('uncategorizedTransactions', 1);
  });

  test.afterAll(async () => {
    await db?.destroy();
  });

  test('a new invoice for a USD customer gets no silent 1: the rate is required', async ({
    page,
  }) => {
    await open(page, '/invoices/new');
    await selectCustomer(page, customerName);

    // No rate service here: the rate comes up empty, not 1.
    const rate = page.locator('input[name="exchangeRate"]');
    await expect(rate).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText('1 USD =').first()).toBeVisible();
    await expect(rate).toHaveValue('', { timeout: 30_000 });

    await page.getByRole('button', { name: /^Save/ }).first().click();
    await expect(page.getByText(REQUIRED).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  // Review: with the rate left empty, typing it and confirming "re-calculate
  // prices" re-priced from an old rate of 0, so every line became 0.
  test('typing the rate into an empty field keeps the line prices', async ({
    page,
  }) => {
    await open(page, '/invoices/new');
    await selectCustomer(page, customerName);
    const rate = page.locator('input[name="exchangeRate"]');
    await expect(rate).toHaveValue('', { timeout: 30_000 });
    await selectEntryItem(page, itemName);

    // The line's rate: the item's price (100) in the first row's inputs.
    const rowValues = () =>
      page.evaluate(() =>
        Array.from(
          document.querySelectorAll('.tbody .tr:first-child input'),
        ).map((input) => (input as HTMLInputElement).value),
      );
    await expect
      .poll(async () => (await rowValues()).some((v) => /^100(\.0+)?$/.test(v)))
      .toBe(true);

    await rate.fill('3.67');
    await rate.blur();
    const calculate = page.getByRole('button', { name: 'Calculate' });
    if (await calculate.isVisible().catch(() => false)) {
      await calculate.click();
    }
    await page.waitForTimeout(500);
    // Still priced (unchanged: there was no old rate to convert from).
    expect((await rowValues()).some((v) => /^100(\.0+)?$/.test(v))).toBe(true);
  });

  test('categorizing a line on a USD bank account asks for the rate', async ({
    page,
  }) => {
    await open(page, `/cashflow-accounts/${usdBankId}/transactions`);
    await page.getByText('Uncategorized Transactions').first().click();
    await page.getByText(`F19 USD deposit ${tag}`).first().click();

    const rate = page.locator('input[name="exchangeRate"]');
    await expect(rate).toBeVisible({ timeout: 30_000 });
    // 1 account currency = rate base currency, as the server books it.
    await expect(page.getByText('1 USD =').first()).toBeVisible();
    await expect(rate).toHaveValue('');

    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByText(REQUIRED).first()).toBeVisible({
      timeout: 15_000,
    });

    await rate.fill('3.67');
    await rate.blur();
    await expect(page.getByText(REQUIRED)).toHaveCount(0);
  });

  // F22: the matching panel's "Pending" total is in the account's currency
  // (it was always formatted as USD).
  test('the matching panel shows the pending total in the account currency', async ({
    page,
  }) => {
    await open(page, `/cashflow-accounts/${aedBankId}/transactions`);
    await page.getByText('Uncategorized Transactions').first().click();
    await page.getByText(`F22 AED deposit ${tag}`).first().click();
    await page.getByRole('tab', { name: /match/i }).first().click();

    const pending = page.getByText(/^Pending/).first();
    await expect(pending).toBeVisible({ timeout: 30_000 });
    await expect(pending).toContainText('AED');
    await expect(pending).not.toContainText('$');
  });
});
