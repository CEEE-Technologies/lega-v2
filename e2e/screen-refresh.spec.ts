import { test, expect, type Locator, type Page } from '@playwright/test';
import {
  accountIdByName,
  api,
  createCustomer,
  createItem,
  createVendor,
  today,
  uniqueTag,
} from './_screens';
import { selectCustomer, selectEntryItem } from './_invoices';

/**
 * F5 / F6 / F7: after a payment, credit or new document, the open details
 * panel, the lists and the payment forms show fresh figures straight away.
 *
 * Every step stays inside the app (no page reload), because a reload would
 * empty the browser's data cache and hide the bug.
 */

/** Navigates inside the single-page app, keeping its data cache. */
async function appNavigate(page: Page, path: string) {
  await page.evaluate((to) => {
    window.history.pushState({}, '', to);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
  }, path);
}

const drawer = (page: Page) => page.locator('.bp4-drawer').first();
const dialog = (page: Page) => page.locator('.bp4-dialog').first();

/** Opens a list row's details panel by clicking its number. */
async function openDetails(page: Page, number: string) {
  await page.getByText(number, { exact: true }).first().click();
  await expect(drawer(page)).toContainText(number, { timeout: 30_000 });
}

async function closeDetails(page: Page) {
  await drawer(page).locator('button[aria-label="Close"]').first().click();
  await expect(page.locator('.bp4-drawer')).toHaveCount(0, {
    timeout: 10_000,
  });
}

/** Picks an account in a dialog's account suggest field. */
async function pickAccount(page: Page, scope: Locator, name: string) {
  const input = scope.getByPlaceholder('Select Account').first();
  await input.click();
  await input.fill(name);
  for (let attempt = 0; attempt < 20; attempt++) {
    const clicked = await page.evaluate((accountName) => {
      const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
      const item = items.find((el) =>
        (el as HTMLElement).innerText.trim().startsWith(accountName),
      );
      if (item) (item as HTMLElement).click();
      return Boolean(item);
    }, name);
    if (clicked) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`[e2e] account "${name}" not found in the picker`);
}

/** Picks a contact in a page's customer or vendor select. */
async function pickContact(page: Page, placeholder: RegExp, name: string) {
  const button = page.getByRole('button', { name: placeholder }).first();
  await button.waitFor({ timeout: 30_000 });
  for (let attempt = 0; attempt < 8; attempt++) {
    await button.focus();
    await page.keyboard.press('Enter');
    const clicked = await page.evaluate((contact) => {
      const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
      const item = items.find((el) =>
        (el as HTMLElement).innerText.trim().includes(contact),
      );
      if (item) (item as HTMLElement).click();
      return Boolean(item);
    }, name);
    if (clicked) return;
    await page.keyboard.press('Escape');
  }
  throw new Error(`[e2e] contact "${name}" not found in the picker`);
}

async function submitDialog(page: Page, button: string) {
  await dialog(page).getByRole('button', { name: button }).click();
  await expect(page.locator('.bp4-dialog')).toHaveCount(0, {
    timeout: 30_000,
  });
}

let tag: string;
let itemId: number;
let itemName: string;

test.beforeAll(async () => {
  tag = uniqueTag();
  itemName = `E2E Refresh Item ${tag}`;
  itemId = await createItem(itemName);
});

test.describe('F5: paying a bill', () => {
  test('refreshes the bill panel, the list and the next pre-filled amount', async ({
    page,
  }) => {
    const vendorId = await createVendor(`E2E Pay Vendor ${uniqueTag()}`);
    const billNumber = `F5-${uniqueTag()}`;
    await api('POST', '/bills', {
      vendorId,
      billDate: today(),
      dueDate: today(),
      billNumber,
      open: true,
      entries: [{ index: 1, itemId, quantity: 1, rate: 5000 }],
    });

    await page.goto('/bills');
    await openDetails(page, billNumber);
    await expect(drawer(page)).toContainText('5,000.00');

    await drawer(page).getByRole('button', { name: 'Add Payment' }).click();
    const payment = dialog(page);
    await expect(payment.locator('input[name="amount"]')).toHaveValue('5,000');
    await payment.locator('input[name="amount"]').fill('2000');
    await payment
      .locator('input[name="paymentNumber"]')
      .fill(`F5-PAY-${uniqueTag()}`);
    await pickAccount(page, payment, 'Bank Account');
    await submitDialog(page, 'Make Payment');

    // The panel shows the new due amount.
    await expect(drawer(page)).toContainText('3,000.00', { timeout: 15_000 });

    // The next payment is pre-filled with what is still due.
    await drawer(page).getByRole('button', { name: 'Add Payment' }).click();
    await expect(dialog(page).locator('input[name="amount"]')).toHaveValue(
      '3,000',
    );
    await dialog(page).getByRole('button', { name: 'Cancel' }).click();

    // The list behind the panel shows it too.
    await closeDetails(page);
    const row = page.getByRole('row').filter({ hasText: billNumber });
    await expect(row).toContainText('3,000', { timeout: 15_000 });
  });
});

test.describe('F6: invoice and credit note panels', () => {
  let customerId: number;
  let customerName: string;

  test.beforeAll(async () => {
    customerName = `E2E Panel Customer ${uniqueTag()}`;
    customerId = await createCustomer(customerName);
  });

  const createInvoice = async (rate: number) => {
    const invoiceNo = `F6-${uniqueTag()}`;
    const invoice = await api('POST', '/sale-invoices', {
      customerId,
      invoiceDate: today(),
      dueDate: today(),
      invoiceNo,
      delivered: true,
      entries: [{ index: 1, itemId, quantity: 1, rate }],
    });
    return { id: invoice.id as number, invoiceNo };
  };

  test('receiving a payment refreshes the invoice panel and the pre-filled amount', async ({
    page,
  }) => {
    const { invoiceNo } = await createInvoice(10000);

    await page.goto('/invoices');
    await openDetails(page, invoiceNo);
    await expect(drawer(page)).toContainText('10,000.00');

    await drawer(page).getByRole('button', { name: 'Add Payment' }).click();
    const payment = dialog(page);
    await expect(payment.locator('input[name="amount"]')).toHaveValue('10,000');
    await payment.locator('input[name="amount"]').fill('3000');
    const number = payment.locator('input[name="paymentReceiveNo"]');
    if ((await number.inputValue()) === '') {
      await number.fill(`F6-PAY-${uniqueTag()}`);
    }
    await pickAccount(page, payment, 'Bank Account');
    await submitDialog(page, 'Make Payment');

    await expect(drawer(page)).toContainText('7,000.00', { timeout: 15_000 });

    await drawer(page).getByRole('button', { name: 'Add Payment' }).click();
    await expect(dialog(page).locator('input[name="amount"]')).toHaveValue(
      '7,000',
    );
  });

  test('deleting a payment refreshes the invoice panel', async ({ page }) => {
    const { id, invoiceNo } = await createInvoice(10000);
    const paymentNo = `F6-DEL-${uniqueTag()}`;
    await api('POST', '/payments-received', {
      customerId,
      paymentDate: today(),
      depositAccountId: await accountIdByName('Bank Account'),
      paymentReceiveNo: paymentNo,
      entries: [{ index: 1, invoiceId: id, paymentAmount: 3000 }],
    });

    // Load the invoice panel once, so the app holds it in its cache.
    await page.goto('/invoices');
    await openDetails(page, invoiceNo);
    await expect(drawer(page)).toContainText('7,000.00');
    await closeDetails(page);

    // Delete the payment from the payments list.
    await appNavigate(page, '/payments-received');
    const row = page.getByRole('row').filter({ hasText: paymentNo });
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: /delete/i }).click();
    await page
      .locator('.bp4-alert')
      .getByRole('button', { name: 'Delete' })
      .click();
    await expect(row).toHaveCount(0, { timeout: 15_000 });

    // Back on the invoice, the whole amount is due again.
    await appNavigate(page, '/invoices');
    await openDetails(page, invoiceNo);
    await expect(drawer(page)).not.toContainText('7,000.00', {
      timeout: 15_000,
    });
  });

  test('refunding a credit note refreshes its panel', async ({ page }) => {
    const creditNoteNumber = `F6-CN-${uniqueTag()}`;
    await api('POST', '/credit-notes', {
      customerId,
      creditNoteDate: today(),
      creditNoteNumber,
      open: true,
      entries: [{ index: 1, itemId, quantity: 1, rate: 500 }],
    });

    await page.goto('/credit-notes');
    await openDetails(page, creditNoteNumber);
    await expect(drawer(page)).toContainText('500.00');

    await drawer(page).getByRole('button', { name: 'Refund' }).click();
    const refund = dialog(page);
    await refund.locator('input[name="amount"]').fill('200');
    await pickAccount(page, refund, 'Bank Account');
    await submitDialog(page, 'Refund');

    // Credits remaining: 500 - 200.
    await expect(drawer(page)).toContainText('300.00', { timeout: 15_000 });
  });
});

test.describe('F7: payment forms list new documents straight away', () => {
  test('a new invoice is listed in the payment form', async ({ page }) => {
    const customerName = `E2E New Doc Customer ${uniqueTag()}`;
    await createCustomer(customerName);

    // Open the payment form for the customer first (nothing to pay yet).
    await page.goto('/payment-received/new');
    await pickContact(page, /Select Customer Account/, customerName);
    await page.waitForLoadState('networkidle');

    // Create and deliver an invoice in the app.
    await appNavigate(page, '/invoices/new');
    await selectCustomer(page, customerName);
    await selectEntryItem(page, itemName);
    const created = page.waitForResponse(
      (res) =>
        new URL(res.url()).pathname === '/api/sale-invoices' &&
        res.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Save & Deliver' }).click();
    const invoice = await (await created).json();
    const invoiceNo = invoice.invoiceNo ?? invoice.invoice_no;

    // The payment form lists it right away.
    await appNavigate(page, '/payment-received/new');
    await pickContact(page, /Select Customer Account/, customerName);
    await expect(page.getByText(invoiceNo).first()).toBeVisible({
      timeout: 15_000,
    });
  });

  test('a bill opened in the app is listed in the payment form', async ({
    page,
  }) => {
    const vendorName = `E2E New Doc Vendor ${uniqueTag()}`;
    const vendorId = await createVendor(vendorName);
    const billNumber = `F7-${uniqueTag()}`;
    const bill = await api('POST', '/bills', {
      vendorId,
      billDate: today(),
      dueDate: today(),
      billNumber,
      open: false,
      entries: [{ index: 1, itemId, quantity: 1, rate: 4000 }],
    });

    // Open the payment form for the vendor first (the bill is a draft).
    await page.goto('/payments-made/new');
    await pickContact(page, /Select Vender Account/, vendorName);
    await page.waitForLoadState('networkidle');

    // Open the bill in the app.
    await appNavigate(page, `/bills/${bill.id}/edit`);
    await page.getByRole('button', { name: 'Save & Open' }).click();
    await page.waitForURL(/\/bills$/, { timeout: 30_000 });

    // The payment form lists it right away.
    await appNavigate(page, '/payments-made/new');
    await pickContact(page, /Select Vender Account/, vendorName);
    await expect(page.getByText(billNumber).first()).toBeVisible({
      timeout: 15_000,
    });
  });
});
