import { test, expect, type Page } from '@playwright/test';
import {
  accountIdByName,
  api,
  createCustomer,
  createVendor,
  today,
  uniqueTag,
} from './_screens';

/**
 * F9: customer and supplier pickers list every contact, not only the first
 * page of 12. The server lists newest first, so the contact created first
 * (below) is the one a 12-row page leaves out.
 */

const FILLERS = 13;

let tag: string;
let customerName: string;
let customerId: number;
let vendorName: string;

test.beforeAll(async () => {
  tag = uniqueTag();
  customerName = `E2E Oldest Customer ${tag}`;
  vendorName = `E2E Oldest Vendor ${tag}`;
  customerId = await createCustomer(customerName);
  await createVendor(vendorName);

  // Newer contacts push the first ones off a 12-row page.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  for (let i = 0; i < FILLERS; i++) {
    await createCustomer(`E2E Filler Customer ${tag} ${i}`);
    await createVendor(`E2E Filler Vendor ${tag} ${i}`);
  }
});

/** Opens a report's "Customize Report" panel and picks a contact in it. */
async function pickInReportFilter(page: Page, url: string, name: string) {
  await page.goto(url);
  await page
    .getByRole('button', { name: /Customize Report/ })
    .first()
    .click();
  const input = page.locator('.bp4-multi-select input, .bp4-tag-input input');
  await input.first().waitFor({ timeout: 30_000 });
  await input.first().click();
  await input.first().fill(name);
  await expect(
    page.getByRole('menuitem').filter({ hasText: name }).first(),
  ).toBeVisible({ timeout: 15_000 });
  await page.getByRole('menuitem').filter({ hasText: name }).first().click();
  await expect(
    page.locator('.bp4-tag').filter({ hasText: name }),
  ).toBeVisible();
}

test('the expense form can pick the oldest customer', async ({ page }) => {
  await page.goto('/expenses/new');
  const button = page
    .getByRole('button', { name: /Select Customer Account/ })
    .first();
  await button.waitFor({ timeout: 30_000 });

  let picked = false;
  for (let attempt = 0; attempt < 8 && !picked; attempt++) {
    await button.focus();
    await page.keyboard.press('Enter');
    picked = await page.evaluate((name) => {
      const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
      const item = items.find((el) =>
        (el as HTMLElement).innerText.includes(name),
      );
      if (item) (item as HTMLElement).click();
      return Boolean(item);
    }, customerName);
    if (!picked) await page.keyboard.press('Escape');
  }
  expect(picked).toBe(true);
  await expect(page.getByRole('button', { name: customerName })).toBeVisible();
});

test('an existing expense shows its customer', async ({ page }) => {
  const expense = await api('POST', '/expenses', {
    paymentDate: today(),
    paymentAccountId: await accountIdByName('Petty Cash'),
    referenceNo: `F9-${tag}`,
    payeeId: customerId,
    publish: false,
    categories: [
      {
        index: 1,
        expenseAccountId: await accountIdByName('Rent'),
        amount: 10,
      },
    ],
  });

  await page.goto(`/expenses/${expense.id}/edit`);
  await expect(page.getByRole('button', { name: customerName })).toBeVisible({
    timeout: 30_000,
  });
});

const REPORTS = [
  ['A/R aging', '/financial-reports/receivable-aging-summary', 'customer'],
  [
    'customer balance summary',
    '/financial-reports/customers-balance-summary',
    'customer',
  ],
  [
    'customer transactions',
    '/financial-reports/transactions-by-customers',
    'customer',
  ],
  ['A/P aging', '/financial-reports/payable-aging-summary', 'vendor'],
  [
    'supplier balance summary',
    '/financial-reports/vendors-balance-summary',
    'vendor',
  ],
  [
    'supplier transactions',
    '/financial-reports/transactions-by-vendors',
    'vendor',
  ],
] as const;

for (const [report, url, contact] of REPORTS) {
  test(`the ${report} filter can pick the oldest ${contact}`, async ({
    page,
  }) => {
    await pickInReportFilter(
      page,
      url,
      contact === 'customer' ? customerName : vendorName,
    );
  });
}
