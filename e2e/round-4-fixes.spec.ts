import { test, expect, type Page } from "@playwright/test";
import { faker } from "@faker-js/faker";
import {
  authCookies,
  createOnboardedUser,
  type AuthSession,
  type OnboardedSession,
} from "./_auth";
import { API_BASE, WEBAPP_BASE } from "./_env";

/**
 * Round 4 screens:
 * - F1: the quick payment (invoice, bill) and refund (credit note, vendor
 *   credit) dialogs show the rate as "1 <document currency> = <rate> <base
 *   currency>", which is how the server uses it (amount x rate = base).
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
      "content-type": "application/json",
      authorization: `Bearer ${session.accessToken}`,
      "organization-id": session.organizationId,
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

test.describe("F1: quick payment and refund dialogs rate label", () => {
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
    await api(owner, "POST", "/currencies", {
      currencyCode: "USD",
      currencyName: "US Dollar",
      currencySign: "$",
    }).catch(() => undefined);

    const accountsRes = await api(owner, "GET", "/accounts");
    const accounts: any[] = Array.isArray(accountsRes)
      ? accountsRes
      : (accountsRes.accounts ?? accountsRes.data);
    const byType = (type: string) =>
      accounts.find((a) => a.accountType === type || a.account_type === type)
        .id;

    const item = await api(owner, "POST", "/items", {
      name: `F1 service ${tag}`,
      type: "service",
      sellable: true,
      purchasable: true,
      sellAccountId: byType("income"),
      costAccountId: byType("cost-of-goods-sold"),
      sellPrice: 100,
      costPrice: 100,
    });
    const entries = [{ index: 1, itemId: item.id, quantity: 1, rate: 100 }];
    const customer = await api(owner, "POST", "/customers", {
      displayName: `F1 USD customer ${tag}`,
      customerType: "business",
      currencyCode: "USD",
    });
    const vendor = await api(owner, "POST", "/vendors", {
      displayName: `F1 USD vendor ${tag}`,
      currencyCode: "USD",
    });

    await api(owner, "POST", "/sale-invoices", {
      customerId: customer.id,
      invoiceDate: "2026-05-01",
      dueDate: "2026-05-31",
      invoiceNo: numbers.invoice,
      exchangeRate: 3.67,
      delivered: true,
      entries,
    });
    await api(owner, "POST", "/bills", {
      vendorId: vendor.id,
      billDate: "2026-05-01",
      dueDate: "2026-05-31",
      billNumber: numbers.bill,
      exchangeRate: 3.67,
      open: true,
      entries,
    });
    await api(owner, "POST", "/credit-notes", {
      customerId: customer.id,
      creditNoteDate: "2026-05-01",
      creditNoteNumber: numbers.creditNote,
      exchangeRate: 3.67,
      open: true,
      entries,
    });
    await api(owner, "POST", "/vendor-credits", {
      vendorId: vendor.id,
      vendorCreditDate: "2026-05-01",
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
    const drawer = page.locator(".bp4-drawer");
    await expect(drawer).toBeVisible({ timeout: 30_000 });
    await drawer
      .locator(".bp4-navbar")
      .getByRole("button", { name: actionText })
      .click();
    const dialog = page.locator(".bp4-dialog");
    await expect(dialog).toBeVisible({ timeout: 30_000 });
    return dialog;
  };

  const cases = [
    ["invoice quick payment", "/invoices", "invoice", "Add Payment"],
    ["bill quick payment", "/bills", "bill", "Add Payment"],
    ["credit note refund", "/credit-notes", "creditNote", "Refund"],
    ["vendor credit refund", "/vendor-credits", "vendorCredit", "Refund"],
  ] as const;

  for (const [name, listPath, key, actionText] of cases) {
    test(`${name}: "1 USD = <rate> AED"`, async ({ page }) => {
      const dialog = await openDialog(page, listPath, numbers[key], actionText);
      // The rate itself is typed by the user (it starts at 1); the label
      // must read in the server's direction whatever the value.
      await expect(dialog).toContainText(/1 USD = [\d.]+ AED/);
      await expect(dialog).not.toContainText(/1 AED =/);
    });
  }
});
