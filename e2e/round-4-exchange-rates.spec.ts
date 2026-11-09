import { test, expect, type Page } from '@playwright/test';
import { faker } from '@faker-js/faker';
import { knex as knexFactory, Knex } from 'knex';
import { knexSnakeCaseMappers } from 'objection';
import { authCookies, createOnboardedUser, type OnboardedSession } from './_auth';
import { API_BASE, WEBAPP_BASE } from './_env';
import { selectCustomer } from './_invoices';

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
  let usdBankId: number;

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
});
