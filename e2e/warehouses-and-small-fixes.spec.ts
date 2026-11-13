import path from 'path';
import { test, expect, type Page } from '@playwright/test';
import { faker } from '@faker-js/faker';
import {
  authCookies,
  createOnboardedUser,
  generateCredentials,
  signInUser,
  signupUser,
  type AuthSession,
  type OnboardedSession,
} from './_auth';
import { API_BASE, WEBAPP_BASE } from './_env';

/**
 * Package 4 (round 3) screens:
 * - Q10: the customer and vendor opening-balance dialogs show the rate as
 *   "1 <contact currency> = <rate> <base currency>".
 * - Q11: a company where the user is deactivated is greyed out in the
 *   company switcher with "Your access was deactivated"; picking it does
 *   nothing (no sign-out), and other companies still switch.
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

/** Reads the newest invite token (the invite email isn't sent locally). */
const inviteToken = async (email: string, tenantId: number) => {
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

/** Invites the member into the owner's company and accepts the invite. */
const inviteMember = async (
  owner: OnboardedSession,
  member: { email: string; password: string },
) => {
  const roles = await api(owner, 'GET', '/roles');
  const role = (roles.data ?? roles).find(
    (r: any) => (r.slug ?? '').toLowerCase() !== 'admin',
  );
  await api(owner, 'PATCH', '/invite', {
    email: member.email,
    roleId: role.id,
  });
  const token = await inviteToken(member.email, owner.tenantId);
  const res = await fetch(`${API_BASE}/api/invite/accept/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      firstName: 'Invited',
      lastName: 'Member',
      password: member.password,
    }),
  });
  expect(res.status).toBeLessThan(300);
};

test.describe('Q10: opening balance exchange rate label', () => {
  let owner: OnboardedSession;

  test.beforeAll(async () => {
    // An AED company (the default), with USD contacts.
    owner = await createOnboardedUser(API_BASE);
    await api(owner, 'POST', '/currencies', {
      currencyCode: 'USD',
      currencyName: 'US Dollar',
      currencySign: '$',
    }).catch(() => undefined);
  });

  const openOpeningBalanceDialog = async (
    page: Page,
    listPath: string,
    displayName: string,
  ) => {
    await signInPage(page, owner, listPath);
    await page.getByText(displayName, { exact: true }).first().click();
    const drawer = page.locator('.bp4-drawer');
    await expect(drawer).toBeVisible({ timeout: 30_000 });
    // The "more" menu is the last (icon-only) button of the actions bar.
    await drawer.locator('.bp4-navbar button').last().click();
    await page.getByText('Edit Opening Balance', { exact: true }).click();
    const dialog = page.locator('.bp4-dialog');
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    return dialog;
  };

  test('vendor: "1 USD = 3.67 AED"', async ({ page }) => {
    const displayName = `P4 USD vendor ${faker.string.alphanumeric(6)}`;
    await api(owner, 'POST', '/vendors', {
      displayName,
      currencyCode: 'USD',
      openingBalance: 100,
      openingBalanceAt: '2026-01-01',
      openingBalanceExchangeRate: 3.67,
    });
    const dialog = await openOpeningBalanceDialog(page, '/vendors', displayName);
    await expect(dialog).toContainText(/1 USD = 3\.67 AED/);
    await expect(dialog).not.toContainText(/1 AED =/);
  });

  test('customer: "1 USD = 3.67 AED"', async ({ page }) => {
    const displayName = `P4 USD customer ${faker.string.alphanumeric(6)}`;
    await api(owner, 'POST', '/customers', {
      displayName,
      customerType: 'business',
      currencyCode: 'USD',
      openingBalance: 100,
      openingBalanceAt: '2026-01-01',
      openingBalanceExchangeRate: 3.67,
    });
    const dialog = await openOpeningBalanceDialog(
      page,
      '/customers',
      displayName,
    );
    await expect(dialog).toContainText(/1 USD = 3\.67 AED/);
    await expect(dialog).not.toContainText(/1 AED =/);
  });
});

test.describe('Q11: deactivated company in the switcher', () => {
  let member: AuthSession;
  let deactivatedIn: OnboardedSession;
  let activeIn: OnboardedSession;

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    // The member's own company, one where they get deactivated, and one
    // where they stay active.
    const credentials = generateCredentials();
    await signupUser(API_BASE, credentials);
    const firstSignin = await signInUser(API_BASE, credentials);
    const { buildOrganization, waitForOrganizationBuild } = await import(
      './_auth'
    );
    const jobId = await buildOrganization(API_BASE, firstSignin, {
      name: `P4 member ${faker.string.alphanumeric(4)}`,
      location: 'AL',
      base_currency: 'AED',
      timezone: 'Pacific/Marquesas',
      fiscal_year: 'june',
      language: 'en',
    });
    await waitForOrganizationBuild(API_BASE, firstSignin, jobId);

    deactivatedIn = await createOnboardedUser(API_BASE, {
      organizationName: `P4 Deactivated ${faker.string.alphanumeric(4)}`,
    });
    activeIn = await createOnboardedUser(API_BASE, {
      organizationName: `P4 Active ${faker.string.alphanumeric(4)}`,
    });
    await inviteMember(deactivatedIn, credentials);
    await inviteMember(activeIn, credentials);

    const users = await api(deactivatedIn, 'GET', '/users');
    const tenantUser = (users.data ?? users).find(
      (u: any) => u.email === credentials.email,
    );
    await api(deactivatedIn, 'PUT', `/users/${tenantUser.id}/inactivate`);

    member = await signInUser(API_BASE, credentials);
  });

  test('is greyed out with a message, and the other company still switches', async ({
    page,
  }) => {
    await signInPage(page, member, '/');

    const deactivated = page.getByTestId(
      `company-${deactivatedIn.organizationId}`,
    );
    const active = page.getByTestId(`company-${activeIn.organizationId}`);
    await expect(deactivated).toBeVisible({ timeout: 60_000 });
    await expect(active).toBeVisible();

    await expect(deactivated).toBeDisabled();
    await expect(deactivated).toHaveClass(/is-disabled/);
    await deactivated.hover({ force: true });
    await expect(page.getByText(/Your access was deactivated/)).toBeVisible();

    // Picking it does nothing: still signed in, still in the same company.
    await deactivated.click({ force: true });
    await page.waitForTimeout(1_000);
    await expect(page).not.toHaveURL(/\/auth\//);
    expect(
      (await page.context().cookies()).find((c) => c.name === 'organization_id')
        ?.value,
    ).toBe(member.organizationId);

    // Another company still switches.
    await active.click();
    await expect
      .poll(
        async () =>
          (await page.context().cookies()).find(
            (c) => c.name === 'organization_id',
          )?.value,
        { timeout: 60_000 },
      )
      .toBe(activeIn.organizationId);
    await expect(page).not.toHaveURL(/\/auth\//);
  });
});
