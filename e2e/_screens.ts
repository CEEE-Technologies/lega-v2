import { expect, type Page } from '@playwright/test';
import { faker } from '@faker-js/faker';
import { readApiAuth } from './_api';
import { API_BASE } from './_env';

/**
 * Small API helpers for the screen refresh / numbering browser tests.
 */
export async function api<T = any>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<T> {
  const auth = readApiAuth();
  const res = await fetch(`${API_BASE}/api${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      authorization: `Bearer ${auth.accessToken}`,
      'organization-id': auth.organizationId,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(
      `[e2e] ${method} ${path} failed: ${res.status} ${JSON.stringify(json)}`,
    );
  }
  return json as T;
}

export const uniqueTag = () => faker.string.alphanumeric(6).toUpperCase();

/** First account with the given name in the chart of accounts. */
export async function accountIdByName(name: string): Promise<number> {
  const res = await api('GET', '/accounts');
  const accounts = res.accounts ?? res.data ?? res;
  const account = accounts.find((row: any) => row.name === name);
  if (!account) throw new Error(`[e2e] account "${name}" not found`);
  return account.id;
}

export async function createItem(
  name: string,
  type: 'service' | 'inventory' = 'service',
): Promise<number> {
  const [sell, cost, inventory] = await Promise.all([
    accountIdByName('Sales of Product Income'),
    accountIdByName('Cost of Goods Sold'),
    accountIdByName('Inventory Asset'),
  ]);
  const item = await api('POST', '/items', {
    name,
    type,
    sellable: true,
    purchasable: true,
    sellPrice: 100,
    costPrice: 50,
    sellAccountId: sell,
    costAccountId: cost,
    ...(type === 'inventory' ? { inventoryAccountId: inventory } : {}),
  });
  return item.id;
}

export async function createCustomer(displayName: string): Promise<number> {
  const customer = await api('POST', '/customers', {
    customerType: 'business',
    displayName,
    currencyCode: await baseCurrency(),
  });
  return customer.id;
}

export async function createVendor(displayName: string): Promise<number> {
  const vendor = await api('POST', '/vendors', {
    displayName,
    currencyCode: await baseCurrency(),
  });
  return vendor.id;
}

/**
 * The test company's currency. The global setup builds it in AED (see
 * `buildOrganization`); reading it from /organization/current instead would
 * use up that route's own rate limit, which the app itself calls often.
 */
export async function baseCurrency(): Promise<string> {
  return 'AED';
}

/** Turns auto-numbering on or off for a settings group. */
export async function setAutoNumbering(
  group: string,
  autoIncrement: boolean,
  prefix = 'E2E-',
  nextNumber = 900,
) {
  await api('PUT', '/settings', {
    options: [
      { group, key: 'auto_increment', value: autoIncrement },
      { group, key: 'number_prefix', value: prefix },
      { group, key: 'next_number', value: nextNumber },
    ],
  });
}

/** Today in YYYY-MM-DD. */
export const today = () => new Date().toISOString().slice(0, 10);

/**
 * Waits until the dashboard's data requests have settled, so effects that
 * run after the data loads (like the number sync) have had their chance.
 */
export async function settle(page: Page) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
}

export async function expectInputValue(
  page: Page,
  name: string,
  value: string,
) {
  await expect(page.locator(`input[name="${name}"]`)).toHaveValue(value, {
    timeout: 30_000,
  });
}
