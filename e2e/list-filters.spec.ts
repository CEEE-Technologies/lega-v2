import { test, expect, type Page } from "@playwright/test";
import {
  authCookies,
  createOnboardedUser,
  type OnboardedSession,
} from "./_auth";
import { API_BASE, WEBAPP_BASE } from "./_env";

/**
 * The list filter popover, driven through the UI on the lists that had
 * broken filters: relation fields (customer, vendor) match the name typed,
 * "does not contain", "bigger or equals" and dates filter, the Amount filter
 * matches the total shown, "is not" negates a status, the customer status is
 * a dropdown, a boolean filter applies unchecked, and the fields that used to
 * fail on the server (item category count, payments made description) load.
 *
 * Each case checks the rows the list API returns for the request the popover
 * sends, and the rows on the table where it has a row test id.
 */
test.use({ storageState: { cookies: [], origins: [] } });

let owner: OnboardedSession;
const numbers: { firstInvoice?: string } = {};

async function api<T = any>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${API_BASE}/api${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${owner.accessToken}`,
      "organization-id": owner.organizationId,
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

test.beforeAll(async () => {
  test.setTimeout(180_000);
  owner = await createOnboardedUser(API_BASE);

  const accountsRes = await api("GET", "/accounts");
  const accounts: any[] = Array.isArray(accountsRes)
    ? accountsRes
    : (accountsRes.accounts ?? accountsRes.data);
  const byType = (type: string) =>
    accounts.find((a) => (a.accountType ?? a.account_type) === type).id;
  const pettyCash = accounts.find((a) => a.name === "Petty Cash").id;

  const customer = async (displayName: string) =>
    (
      await api("POST", "/customers", {
        customerType: "business",
        displayName,
        currencyCode: "AED",
      })
    ).id;
  const vendor = async (displayName: string) =>
    (await api("POST", "/vendors", { displayName, currencyCode: "AED" })).id;

  const alpha = await customer("Alpha Traders");
  const beta = await customer("Beta Supplies");
  const delta = await vendor("Delta Vendor");
  const echo = await vendor("Echo Vendor");

  const category = (
    await api("POST", "/item-categories", { name: "Services Cat" })
  ).id;
  await api("POST", "/item-categories", { name: "Goods Cat" });
  const itemId = (
    await api("POST", "/items", {
      name: "Consulting",
      type: "service",
      sellable: true,
      purchasable: true,
      sellPrice: 100,
      costPrice: 50,
      sellAccountId: byType("income"),
      costAccountId: byType("cost-of-goods-sold"),
      categoryId: category,
    })
  ).id;
  const entries = (rate: number) => [{ index: 1, itemId, rate, quantity: 1 }];

  const invoice = (
    customerId: number,
    date: string,
    rate: number,
    extra = {},
  ) =>
    api("POST", "/sale-invoices", {
      customerId,
      invoiceDate: date,
      dueDate: date,
      delivered: true,
      entries: entries(rate),
      ...extra,
    });
  const first = await invoice(alpha, "2026-11-01", 100);
  numbers.firstInvoice = first.invoiceNo ?? first.invoice_no;
  // Paid, so Alpha has no overdue invoice.
  await api("POST", "/payments-received", {
    customerId: alpha,
    paymentDate: "2026-11-02",
    depositAccountId: pettyCash,
    entries: [{ index: 1, invoiceId: first.id, paymentAmount: 100 }],
  });
  await invoice(beta, "2026-11-05", 250);
  await invoice(alpha, "2026-11-10", 500, { delivered: false });
  // Subtotal 1000, total 900: the Amount column shows 900.
  await invoice(beta, "2026-11-11", 1000, {
    dueDate: "2099-12-31",
    discount: 10,
    discountType: "percentage",
  });

  const bill = (vendorId: number, rate: number, billNumber: string) =>
    api("POST", "/bills", {
      vendorId,
      billDate: "2026-11-02",
      dueDate: "2026-11-02",
      billNumber,
      exchangeRate: 1,
      open: true,
      entries: entries(rate),
    });
  const deltaBill = await bill(delta, 200, "FLT-B1");
  await bill(echo, 400, "FLT-B2");
  await bill(echo, 300, "FLT-B3");
  await api("POST", "/bill-payments", {
    vendorId: delta,
    paymentDate: "2026-11-03",
    paymentAccountId: pettyCash,
    statement: "Paid by bank transfer",
    entries: [{ index: 1, billId: deltaBill.id, paymentAmount: 200 }],
  });
});

test.beforeEach(async ({ page }) => {
  await page
    .context()
    .addCookies(authCookies(owner, new URL(WEBAPP_BASE).hostname));
});

/** Opens a list page and its filter popover. */
async function openFilter(page: Page, url: string) {
  await page.goto(url);
  // Let the list load first: the toolbar re-renders when the data arrives,
  // which closes a dropdown opened in the popover meanwhile.
  await page.waitForLoadState("networkidle");
  const filterButton = page.getByRole("button", {
    name: /filter|filters applied/i,
  });
  await expect(filterButton).toBeVisible({ timeout: 30_000 });
  await filterButton.click();
  await expect(
    page.locator(".filter-dropdown__condition").first(),
  ).toBeVisible();
  await page.waitForLoadState("networkidle");
}

/**
 * Picks an option from a filter-row select (field, comparator, option). The
 * select's popover can close when the list re-renders behind it, so the pick
 * is retried until the select shows the option.
 */
async function pick(page: Page, group: string, row: number, label: string) {
  const condition = page.locator(".filter-dropdown__condition").nth(row);
  const button = condition.locator(`.form-group--${group} button`).first();
  // Field options show their label twice (text and hint), so match the
  // option whose text is exactly the label.
  const option = page
    .locator(".bp4-popover-content .bp4-menu-item")
    .filter({ has: page.getByText(label, { exact: true }) })
    .first();

  for (let attempt = 0; attempt < 6; attempt++) {
    if (!(await option.isVisible())) await button.click();
    try {
      await option.click({ timeout: 3_000 });
    } catch {
      continue;
    }
    if ((await button.innerText()).trim() === label) return;
  }
  await expect(button).toHaveText(label);
}

/**
 * Waits for the list request carrying the given filter field, comparator and
 * value, and returns the number of rows it returned.
 */
function waitForFilteredRows(
  page: Page,
  listPath: string,
  expected: { fieldKey: string; comparator: string; value: unknown },
) {
  return page
    .waitForResponse(
      (response) => {
        if (!response.url().includes(listPath) || !response.ok()) return false;
        const roles = new URL(response.url()).searchParams.get(
          "stringified_filter_roles",
        );
        if (!roles) return false;
        return JSON.parse(roles).some(
          (r: any) =>
            r.fieldKey === expected.fieldKey &&
            r.comparator === expected.comparator &&
            r.value === expected.value,
        );
      },
      { timeout: 30_000 },
    )
    .then(async (response) => {
      const json = await response.json();
      if (json?.pagination?.total !== undefined) return json.pagination.total;
      return findRows(json).length;
    });
}

/** The first array of rows in a list response. */
function findRows(json: any): any[] {
  if (Array.isArray(json)) return json;
  for (const value of Object.values(json ?? {})) {
    if (Array.isArray(value)) return value;
  }
  for (const value of Object.values(json ?? {})) {
    if (value && typeof value === "object") {
      const rows = findRows(value);
      if (rows.length) return rows;
    }
  }
  return [];
}

test.describe("List filters", () => {
  test("invoices: customer contains a name", async ({ page }) => {
    await openFilter(page, "/invoices");
    await pick(page, "fieldKey", 0, "Customer");
    const rows = waitForFilteredRows(page, "/api/sale-invoices", {
      fieldKey: "customer",
      comparator: "contain",
      value: "Alpha",
    });
    await page.getByPlaceholder("Value").first().fill("Alpha");
    expect(await rows).toBe(2);

    await expect(page.getByTestId("invoice-row")).toHaveCount(2);
    await expect(
      page.getByTestId("invoice-row").filter({ hasText: "Beta Supplies" }),
    ).toHaveCount(0);
  });

  test("invoices: invoice number does not contain", async ({ page }) => {
    await openFilter(page, "/invoices");
    await pick(page, "comparator", 0, "Not Contain");
    const rows = waitForFilteredRows(page, "/api/sale-invoices", {
      fieldKey: "invoice_no",
      comparator: "not_contain",
      value: numbers.firstInvoice,
    });
    await page.getByPlaceholder("Value").first().fill(numbers.firstInvoice!);
    expect(await rows).toBe(3);
    await expect(page.getByTestId("invoice-row")).toHaveCount(3);
  });

  test("invoices: amount bigger or equals matches the total shown", async ({
    page,
  }) => {
    await openFilter(page, "/invoices");
    await pick(page, "fieldKey", 0, "Amount");
    await pick(page, "comparator", 0, "Bigger or equals");
    const rows = waitForFilteredRows(page, "/api/sale-invoices", {
      fieldKey: "amount",
      comparator: "bigger_or_equal",
      value: "900",
    });
    await page.getByPlaceholder("Value").first().fill("900");
    // Only the 1000 subtotal / 900 total invoice.
    expect(await rows).toBe(1);
    await expect(page.getByTestId("invoice-row")).toHaveCount(1);
  });

  test("invoices: status is not draft", async ({ page }) => {
    await openFilter(page, "/invoices");
    await pick(page, "fieldKey", 0, "Status");
    await pick(page, "comparator", 0, "Is Not");
    const rows = waitForFilteredRows(page, "/api/sale-invoices", {
      fieldKey: "status",
      comparator: "is_not",
      value: "draft",
    });
    await pick(page, "value", 0, "Draft");
    expect(await rows).toBe(3);
    await expect(page.getByTestId("invoice-row")).toHaveCount(3);
  });

  test("invoices: invoice date in a day", async ({ page }) => {
    await openFilter(page, "/invoices");
    await pick(page, "fieldKey", 0, "Invoice date");
    const rows = waitForFilteredRows(page, "/api/sale-invoices", {
      fieldKey: "invoice_date",
      comparator: "in",
      value: "2026/11/05",
    });
    // Typed in the organization's date format; sent as YYYY/MM/DD.
    const dateInput = page.getByPlaceholder("Enter date").first();
    await dateInput.fill("05 Nov 2026");
    await dateInput.press("Enter");
    expect(await rows).toBe(1);
    await expect(page.getByTestId("invoice-row")).toHaveCount(1);
  });

  test("invoices: two conditions with AND", async ({ page }) => {
    await openFilter(page, "/invoices");
    await pick(page, "fieldKey", 0, "Customer");
    await page.getByPlaceholder("Value").first().fill("Alpha");

    await pick(page, "condition", 1, "And");
    await pick(page, "fieldKey", 1, "Amount");
    await pick(page, "comparator", 1, "Bigger than");
    const rows = waitForFilteredRows(page, "/api/sale-invoices", {
      fieldKey: "amount",
      comparator: "bigger_than",
      value: "200",
    });
    await page.getByPlaceholder("Value").nth(1).fill("200");
    // Alpha's 500 invoice only.
    expect(await rows).toBe(1);
    await expect(page.getByTestId("invoice-row")).toHaveCount(1);
  });

  test('customers: status is a dropdown and "overdue" filters', async ({
    page,
  }) => {
    await openFilter(page, "/customers");
    await pick(page, "fieldKey", 0, "Status");
    const rows = waitForFilteredRows(page, "/api/customers", {
      fieldKey: "status",
      comparator: "is",
      value: "overdue",
    });
    await pick(page, "value", 0, "Overdue");
    // Beta's delivered 250 invoice is past due; Alpha's is paid.
    expect(await rows).toBe(1);
    await expect(page.getByTestId("customer-row")).toHaveCount(1);
    await expect(page.getByTestId("customer-row")).toContainText(
      "Beta Supplies",
    );
  });

  test("bills: vendor contains a name", async ({ page }) => {
    await openFilter(page, "/bills");
    await pick(page, "fieldKey", 0, "Vendor");
    const rows = waitForFilteredRows(page, "/api/bills", {
      fieldKey: "vendor",
      comparator: "contain",
      value: "Echo",
    });
    await page.getByPlaceholder("Value").first().fill("Echo");
    expect(await rows).toBe(2);
  });

  test("payments made: description contains", async ({ page }) => {
    await openFilter(page, "/payments-made");
    await pick(page, "fieldKey", 0, "Description");
    const rows = waitForFilteredRows(page, "/api/bill-payments", {
      fieldKey: "description",
      comparator: "contain",
      value: "bank",
    });
    await page.getByPlaceholder("Value").first().fill("bank");
    expect(await rows).toBe(1);
  });

  test("item categories: count equals", async ({ page }) => {
    await openFilter(page, "/items/categories");
    await pick(page, "fieldKey", 0, "Count");
    const rows = waitForFilteredRows(page, "/api/item-categories", {
      fieldKey: "count",
      comparator: "equal",
      value: "1",
    });
    await page.getByPlaceholder("Value").first().fill("1");
    expect(await rows).toBe(1);
    await expect(page.getByTestId("category-row")).toHaveCount(1);
  });

  test("items: a boolean filter applies unchecked and checked", async ({
    page,
  }) => {
    await openFilter(page, "/items");
    const unchecked = waitForFilteredRows(page, "/api/items", {
      fieldKey: "sellable",
      comparator: "is",
      value: false,
    });
    await pick(page, "fieldKey", 0, "Sellable");
    expect(await unchecked).toBe(0);

    const checked = waitForFilteredRows(page, "/api/items", {
      fieldKey: "sellable",
      comparator: "is",
      value: true,
    });
    await page
      .locator(".filter-dropdown__condition")
      .first()
      .locator(".form-group--value label.bp4-checkbox")
      .click();
    expect(await checked).toBe(1);
  });

  test("credit notes: the filter opens on the credit note number", async ({
    page,
  }) => {
    await openFilter(page, "/credit-notes");
    await expect(
      page
        .locator(".filter-dropdown__condition")
        .first()
        .locator(".form-group--fieldKey button"),
    ).toContainText("Credit Note Number");
    await expect(page.getByPlaceholder("Value").first()).toBeVisible();
  });
});
