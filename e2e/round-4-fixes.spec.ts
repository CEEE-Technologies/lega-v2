import path from 'path';
import { test, expect, type Page } from '@playwright/test';
import { faker } from '@faker-js/faker';
import {
  authCookies,
  createOnboardedUser,
  signInUser,
  type AuthSession,
  type OnboardedSession,
} from './_auth';
import { API_BASE, WEBAPP_BASE } from './_env';

/**
 * Round 4 screens:
 * - F1: the quick payment (invoice, bill) and refund (credit note, vendor
 *   credit) dialogs show the rate as "1 <document currency> = <rate> <base
 *   currency>", which is how the server uses it (amount x rate = base).
 * - F12: every list's right-click row menu opens and stays open.
 * - F6: the users list explains an admin-only refusal.
 */
test.use({ storageState: { cookies: [], origins: [] } });

const api = async (
  session: AuthSession,
  method: string,
  url: string,
  body?: unknown,
) => {
  const res = await fetch(`${API_BASE}/api${url}`, {
    method,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${session.accessToken}`,
      'organization-id': session.organizationId,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(`${method} ${url}: ${res.status} ${JSON.stringify(json)}`);
  }
  return json;
};

const signInPage = async (page: Page, session: AuthSession, to: string) => {
  await page
    .context()
    .addCookies(authCookies(session, new URL(WEBAPP_BASE).hostname));
  await page.goto(to);
};

test.describe('F1: quick payment and refund dialogs rate label', () => {
  let owner: OnboardedSession;
  const tag = faker.string.alphanumeric(6);
  const numbers = {
    invoice: `F1-INV-${tag}`,
    bill: `F1-BILL-${tag}`,
    creditNote: `F1-CN-${tag}`,
    vendorCredit: `F1-VC-${tag}`,
  };

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    // An AED company (the default), with a USD customer and vendor.
    owner = await createOnboardedUser(API_BASE);
    await api(owner, 'POST', '/currencies', {
      currencyCode: 'USD',
      currencyName: 'US Dollar',
      currencySign: '$',
    }).catch(() => undefined);

    const accountsRes = await api(owner, 'GET', '/accounts');
    const accounts: any[] = Array.isArray(accountsRes)
      ? accountsRes
      : (accountsRes.accounts ?? accountsRes.data);
    const byType = (type: string) =>
      accounts.find((a) => a.accountType === type || a.account_type === type)
        .id;

    const item = await api(owner, 'POST', '/items', {
      name: `F1 service ${tag}`,
      type: 'service',
      sellable: true,
      purchasable: true,
      sellAccountId: byType('income'),
      costAccountId: byType('cost-of-goods-sold'),
      sellPrice: 100,
      costPrice: 100,
    });
    const entries = [{ index: 1, itemId: item.id, quantity: 1, rate: 100 }];
    const customer = await api(owner, 'POST', '/customers', {
      displayName: `F1 USD customer ${tag}`,
      customerType: 'business',
      currencyCode: 'USD',
    });
    const vendor = await api(owner, 'POST', '/vendors', {
      displayName: `F1 USD vendor ${tag}`,
      currencyCode: 'USD',
    });

    await api(owner, 'POST', '/sale-invoices', {
      customerId: customer.id,
      invoiceDate: '2026-05-01',
      dueDate: '2026-05-31',
      invoiceNo: numbers.invoice,
      exchangeRate: 3.67,
      delivered: true,
      entries,
    });
    await api(owner, 'POST', '/bills', {
      vendorId: vendor.id,
      billDate: '2026-05-01',
      dueDate: '2026-05-31',
      billNumber: numbers.bill,
      exchangeRate: 3.67,
      open: true,
      entries,
    });
    await api(owner, 'POST', '/credit-notes', {
      customerId: customer.id,
      creditNoteDate: '2026-05-01',
      creditNoteNumber: numbers.creditNote,
      exchangeRate: 3.67,
      open: true,
      entries,
    });
    await api(owner, 'POST', '/vendor-credits', {
      vendorId: vendor.id,
      vendorCreditDate: '2026-05-01',
      vendorCreditNumber: numbers.vendorCredit,
      exchangeRate: 3.67,
      open: true,
      entries,
    });
  });

  const openDialog = async (
    page: Page,
    listPath: string,
    documentNumber: string,
    actionText: string,
  ) => {
    await signInPage(page, owner, listPath);
    await page.getByText(documentNumber, { exact: true }).first().click();
    const drawer = page.locator('.bp4-drawer');
    await expect(drawer).toBeVisible({ timeout: 30_000 });
    await drawer
      .locator('.bp4-navbar')
      .getByRole('button', { name: actionText })
      .click();
    const dialog = page.locator('.bp4-dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    return dialog;
  };

  const cases = [
    ['invoice quick payment', '/invoices', 'invoice', 'Add Payment'],
    ['bill quick payment', '/bills', 'bill', 'Add Payment'],
    ['credit note refund', '/credit-notes', 'creditNote', 'Refund'],
    ['vendor credit refund', '/vendor-credits', 'vendorCredit', 'Refund'],
  ] as const;

  for (const [name, listPath, key, actionText] of cases) {
    test(`${name}: "1 USD = <rate> AED"`, async ({ page }) => {
      const dialog = await openDialog(page, listPath, numbers[key], actionText);
      // The label reads in the server's direction, and (F18) the rate
      // starts at the document's own rate, not 1.
      await expect(dialog).toContainText('1 USD = 3.67 AED');
      await expect(dialog).not.toContainText(/1 AED =/);
    });
  }
});

/**
 * F12: every list's right-click row menu opens and stays open. (The menus
 * worked; the failing list tests right-clicked while the filtered list was
 * still loading, and the new rows replaced the one whose menu was open.)
 */
test.describe('F12: right-click row menus', () => {
  let owner: OnboardedSession;
  const tag = faker.string.alphanumeric(6).toUpperCase();
  const names = {
    customer: `F12 Customer ${tag}`,
    vendor: `F12 Vendor ${tag}`,
    item: `F12 Item ${tag}`,
    account: `F12 Account ${tag}`,
    invoice: `F12-INV-${tag}`,
    estimate: `F12-EST-${tag}`,
    receipt: `F12-REC-${tag}`,
    bill: `F12-BILL-${tag}`,
    creditNote: `F12-CN-${tag}`,
    vendorCredit: `F12-VC-${tag}`,
    journal: `F12-MJ-${tag}`,
    // The expenses list shows the amount (the description is a tooltip).
    expense: '4,321.09',
  };

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    owner = await createOnboardedUser(API_BASE);
    const accountsRes = await api(owner, 'GET', '/accounts');
    const accounts: any[] = Array.isArray(accountsRes)
      ? accountsRes
      : (accountsRes.accounts ?? accountsRes.data);
    const byType = (type: string) =>
      accounts.find((a) => (a.accountType ?? a.account_type) === type).id;
    const bank = byType('bank');
    const income = byType('income');
    const expense = byType('expense');

    const item = await api(owner, 'POST', '/items', {
      name: names.item,
      type: 'service',
      sellable: true,
      purchasable: true,
      sellAccountId: income,
      costAccountId: byType('cost-of-goods-sold'),
      sellPrice: 100,
      costPrice: 100,
    });
    const entries = [{ index: 1, itemId: item.id, quantity: 1, rate: 100 }];
    const customer = await api(owner, 'POST', '/customers', {
      displayName: names.customer,
      customerType: 'business',
      currencyCode: 'AED',
    });
    const vendor = await api(owner, 'POST', '/vendors', {
      displayName: names.vendor,
      currencyCode: 'AED',
    });
    const date = '2026-05-01';
    await api(owner, 'POST', '/accounts', {
      name: names.account,
      code: `F${faker.string.numeric(5)}`,
      accountType: 'expense',
    });
    await api(owner, 'POST', '/sale-invoices', {
      customerId: customer.id,
      invoiceDate: date,
      dueDate: date,
      invoiceNo: names.invoice,
      delivered: true,
      entries,
    });
    await api(owner, 'POST', '/sale-estimates', {
      customerId: customer.id,
      estimateDate: date,
      expirationDate: date,
      estimateNumber: names.estimate,
      entries,
    });
    await api(owner, 'POST', '/sale-receipts', {
      customerId: customer.id,
      depositAccountId: bank,
      receiptDate: date,
      receiptNumber: names.receipt,
      closed: true,
      entries,
    });
    await api(owner, 'POST', '/bills', {
      vendorId: vendor.id,
      billDate: date,
      dueDate: date,
      billNumber: names.bill,
      open: true,
      entries,
    });
    await api(owner, 'POST', '/credit-notes', {
      customerId: customer.id,
      creditNoteDate: date,
      creditNoteNumber: names.creditNote,
      open: true,
      entries,
    });
    await api(owner, 'POST', '/vendor-credits', {
      vendorId: vendor.id,
      vendorCreditDate: date,
      vendorCreditNumber: names.vendorCredit,
      open: true,
      entries,
    });
    await api(owner, 'POST', '/manual-journals', {
      date,
      journalNumber: names.journal,
      publish: true,
      entries: [
        { index: 1, accountId: expense, debit: 10, credit: 0 },
        { index: 2, accountId: bank, debit: 0, credit: 10 },
      ],
    });
    await api(owner, 'POST', '/expenses', {
      paymentDate: date,
      paymentAccountId: bank,
      description: `F12 expense ${tag}`,
      publish: true,
      categories: [
        {
          index: 1,
          expenseAccountId: expense,
          amount: 4321.09,
          description: '',
        },
      ],
    });
  });

  const lists = [
    ['/invoices', 'invoice'],
    ['/estimates', 'estimate'],
    ['/receipts', 'receipt'],
    ['/bills', 'bill'],
    ['/credit-notes', 'creditNote'],
    ['/vendor-credits', 'vendorCredit'],
    ['/manual-journals', 'journal'],
    ['/expenses', 'expense'],
    ['/customers', 'customer'],
    ['/vendors', 'vendor'],
    ['/items', 'item'],
    // The chart of accounts only renders the rows in view: use the first.
    ['/accounts', null],
  ] as const;

  for (const [listPath, key] of lists) {
    test(`${listPath}: the row menu opens and stays open`, async ({ page }) => {
      await signInPage(page, owner, listPath);
      const rows = page.locator('.tbody .tr');
      const row = (key ? rows.filter({ hasText: names[key] }) : rows).first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      // Let the list settle (no request in flight) before right-clicking.
      await page.waitForLoadState('networkidle');

      await row.click({ button: 'right' });
      const menu = page.locator('.bp4-context-menu-popover-target .bp4-menu');
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('menuitem').first()).toBeVisible();
      await page.waitForTimeout(1000);
      await expect(menu).toBeVisible();
      await menu.getByRole('menuitem').first().hover();
    });
  }
});

/**
 * F6: a user who can manage users but isn't an admin gets "Only an admin
 * can do this." when deactivating an admin from the users list.
 */
test.describe('F6: the users list explains an admin-only refusal', () => {
  let owner: OnboardedSession;
  let manny: AuthSession;
  const wideRoleName = `F7 Wide ${faker.string.alphanumeric(5)}`;
  const anaEmail = `f6-ana-${faker.string.alphanumeric(8).toLowerCase()}@example.com`;

  /** Reads the newest invite token (the invite email isn't sent locally). */
  const inviteToken = async (email: string, tenantId: string | number) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const knex = require(
      path.join(__dirname, '../packages/server/node_modules/knex'),
    );
    const db = knex({
      client: 'mysql2',
      connection: {
        host: process.env.DB_HOST,
        port: Number(process.env.DB_PORT || 3306),
        user: process.env.SYSTEM_DB_USER || process.env.DB_USER,
        password: process.env.SYSTEM_DB_PASSWORD || process.env.DB_PASSWORD,
        database: process.env.SYSTEM_DB_NAME,
      },
    });
    try {
      const [rows] = await db.raw(
        'SELECT TOKEN AS token FROM USER_INVITES WHERE EMAIL = ? AND TENANT_ID = ? ORDER BY ID DESC LIMIT 1',
        [email, tenantId],
      );
      return rows[0]?.token as string;
    } finally {
      await db.destroy();
    }
  };

  const inviteAndAccept = async (
    email: string,
    password: string,
    roleId: number,
  ) => {
    await api(owner, 'PATCH', '/invite', { email, roleId });
    const token = await inviteToken(email, owner.tenantId);
    const res = await fetch(`${API_BASE}/api/invite/accept/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ firstName: 'F6', lastName: 'User', password }),
    });
    expect(res.status).toBeLessThan(300);
  };

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    owner = await createOnboardedUser(API_BASE);
    const roles = await api(owner, 'GET', '/roles');
    const adminRole = (roles.data ?? roles).find(
      (r: any) => (r.slug ?? '').toLowerCase() === 'admin',
    );
    const managerRole = await api(owner, 'POST', '/roles', {
      roleName: `F6 Manager ${faker.string.alphanumeric(5)}`,
      roleDescription: 'Can manage users',
      // Viewing roles too: the invite dialog lists the roles with it.
      permissions: [
        { subject: 'User', ability: 'Manage', value: true },
        { subject: 'Role', ability: 'View', value: true },
      ],
    });
    await inviteAndAccept(anaEmail, 'Secur1ty-Test-Pass', adminRole.id);
    const mannyCredentials = {
      firstName: 'Manny',
      lastName: 'Manager',
      email: `f6-manny-${faker.string.alphanumeric(8).toLowerCase()}@example.com`,
      password: 'Secur1ty-Test-Pass',
    };
    await inviteAndAccept(
      mannyCredentials.email,
      mannyCredentials.password,
      (managerRole.data ?? managerRole).id,
    );
    manny = await signInUser(API_BASE, mannyCredentials);
    await api(owner, 'POST', '/roles', {
      roleName: wideRoleName,
      roleDescription: 'More than a user manager has',
      permissions: [
        { subject: 'User', ability: 'Manage', value: true },
        { subject: 'Bill', ability: 'Delete', value: true },
      ],
    });
  });

  test('F7: inviting with a role wider than your own shows "You can only give permissions you have yourself."', async ({
    page,
  }) => {
    await signInPage(page, manny, '/preferences/users');
    await page.getByRole('button', { name: 'Invite User' }).click();
    const dialog = page.locator('.bp4-dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    await dialog
      .locator('input[name="email"]')
      .fill(`f7-${faker.string.alphanumeric(8).toLowerCase()}@example.com`);
    // The role select opens on Enter (as the other list tests do it).
    const select = dialog
      .locator('.bp4-form-group')
      .filter({ hasText: 'Role name' })
      .locator('button, [tabindex="0"]')
      .first();
    let picked = false;
    for (let attempt = 0; attempt < 8 && !picked; attempt++) {
      await select.focus();
      await page.keyboard.press('Enter');
      picked = await page.evaluate((roleName) => {
        const item = Array.from(
          document.querySelectorAll('[role="menuitem"]'),
        ).find((el) => (el as HTMLElement).innerText.trim() === roleName);
        (item as HTMLElement | undefined)?.click();
        return !!item;
      }, wideRoleName);
    }
    expect(picked).toBe(true);
    await expect(dialog).toContainText(wideRoleName);
    await dialog.getByRole('button', { name: 'Invite' }).click();
    await expect(
      dialog.getByText('You can only give permissions you have yourself.'),
    ).toBeVisible({ timeout: 15_000 });
  });

  test('deactivating an admin shows "Only an admin can do this."', async ({
    page,
  }) => {
    await signInPage(page, manny, '/preferences/users');
    const row = page
      .locator('.tbody .tr')
      .filter({ hasText: anaEmail })
      .first();
    await expect(row).toBeVisible({ timeout: 30_000 });
    await page.waitForLoadState('networkidle');

    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Inactivate User' }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Inactivate' })
      .click();
    await expect(page.getByText('Only an admin can do this.')).toBeVisible({
      timeout: 15_000,
    });
  });
});
