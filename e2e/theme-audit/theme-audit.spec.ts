/**
 * Visits every main screen in light and dark theme, opens record detail
 * drawers, and reports text that is unreadable against its background.
 *
 * Run: pnpm exec playwright test -c playwright.theme-audit.config.ts
 * Report: test-results/theme-audit/<theme>__<page>.json (+ screenshots).
 * Each finding has a `kind`: low-contrast text, a panel painted for the other
 * theme, an invisible or harsh border, or an unreadable disabled button.
 */
import fs from "fs";
import path from "path";
import { test, type Page } from "@playwright/test";
import {
  createCustomerViaApi,
  createDeliveredInvoiceViaApi,
  createExpenseViaApi,
  createItemViaApi,
  createManualJournalViaApi,
  createOpenedBillViaApi,
  createVendorViaApi,
  fetchAccounts,
  readApiAuth,
} from "../_api";
import {
  findBorderIssues,
  findLowContrastText,
  findUnreadableDisabledButtons,
  findWrongThemeSurfaces,
} from "./contrast";
import { API_BASE } from "../_env";

const OUT = path.resolve(__dirname, "../../test-results/theme-audit");
const THEMES = ["light", "dark"] as const;

const PAGES = [
  "/",
  "/accounts",
  "/manual-journals",
  "/make-journal-entry",
  "/items",
  "/items/new",
  "/items/categories",
  "/inventory-adjustments",
  "/warehouses-transfers",
  "/customers",
  "/customers/new",
  "/vendors",
  "/vendors/new",
  "/estimates",
  "/estimates/new",
  "/invoices",
  "/invoices/new",
  "/receipts",
  "/receipts/new",
  "/credit-notes",
  "/credit-notes/new",
  "/payments-received",
  "/payment-received/new",
  "/bills",
  "/bills/new",
  "/vendor-credits",
  "/vendor-credits/new",
  "/payments-made",
  "/payments-made/new",
  "/expenses",
  "/expenses/new",
  "/cashflow-accounts",
  "/tax-rates",
  "/bank-rules",
  "/transactions-locking",
  "/invoices/import",
  "/financial-reports",
  "/financial-reports/balance-sheet",
  "/financial-reports/profit-loss-sheet",
  "/financial-reports/trial-balance-sheet",
  "/financial-reports/general-ledger",
  "/financial-reports/journal-sheet",
  "/financial-reports/cash-flow",
  "/financial-reports/receivable-aging-summary",
  "/financial-reports/payable-aging-summary",
  "/financial-reports/customers-balance-summary",
  "/financial-reports/vendors-balance-summary",
  "/financial-reports/transactions-by-customers",
  "/financial-reports/transactions-by-vendors",
  "/financial-reports/sales-by-items",
  "/financial-reports/purchases-by-items",
  "/financial-reports/inventory-valuation",
  "/financial-reports/inventory-item-details",
  "/financial-reports/sales-tax-liability-summary",
  "/preferences/general",
  "/preferences/branding",
  "/preferences/users",
  "/preferences/roles",
  "/preferences/invoices",
  "/preferences/estimates",
  "/preferences/receipts",
  "/preferences/credit-notes",
  "/preferences/currencies",
  "/preferences/accountant",
  "/preferences/items",
  "/preferences/payment-methods",
  "/preferences/api-keys",
  "/preferences/sms-message",
];

/**
 * Reports whose light design draws a grey rule above the double-underlined
 * total (the other reports use a black rule there on purpose).
 */
const GREY_TOTAL_RULE_REPORTS = [
  "/financial-reports/customers-balance-summary",
  "/financial-reports/vendors-balance-summary",
  "/financial-reports/sales-by-items",
  "/financial-reports/purchases-by-items",
];

/** List pages whose first row opens a detail drawer. */
const DRAWERS = [
  "/invoices",
  "/receipts",
  "/estimates",
  "/credit-notes",
  "/payments-received",
  "/bills",
  "/vendor-credits",
  "/payments-made",
  "/expenses",
  "/manual-journals",
  "/customers",
  "/vendors",
  "/items",
  "/accounts",
];

const slug = (route: string) =>
  route.replace(/^\//, "").replace(/[^\w]+/g, "_") || "dashboard";

async function post(pathname: string, body: unknown) {
  const auth = readApiAuth();
  const res = await fetch(`${API_BASE}/api${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${auth.accessToken}`,
      "organization-id": auth.organizationId,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    console.warn(`[theme-audit] seed ${pathname} failed`, res.status, json);
  }
  return json;
}

/** Uploads a CSV through the import flow (upload, map columns, import). */
async function importCsv(
  resource: string,
  csv: string,
  mapping: Array<{ from: string; to: string }>,
  params: Record<string, unknown> = {},
) {
  const auth = readApiAuth();
  const headers = {
    authorization: `Bearer ${auth.accessToken}`,
    "organization-id": auth.organizationId,
  };
  const form = new FormData();
  form.append("file", new Blob([csv], { type: "text/csv" }), "audit.csv");
  form.append("resource", resource);
  form.append("params", JSON.stringify(params));
  const res = await fetch(`${API_BASE}/api/import/file`, {
    method: "POST",
    headers,
    body: form,
  });
  const json: any = await res.json().catch(() => null);
  const importId = json?.import?.importId ?? json?.import?.import_id;
  if (!res.ok || !importId) {
    console.warn(`[theme-audit] import upload failed`, res.status, json);
    return;
  }
  await post(`/import/${importId}/mapping`, { mapping });
  await post(`/import/${importId}/import`, {});
}

const today = () => new Date().toISOString().slice(0, 10);

/** Ids created by the seed, kept on disk because workers restart. */
interface SeedInfo {
  bankAccountId?: number;
}
const seedInfoPath = () =>
  path.join(OUT, `.seeded-${readApiAuth().organizationId}`);
const readSeedInfo = (): SeedInfo => {
  try {
    return JSON.parse(fs.readFileSync(seedInfoPath(), "utf8") || "{}");
  } catch {
    return {};
  }
};

async function seed(): Promise<SeedInfo> {
  const auth = readApiAuth();
  const accounts = await fetchAccounts(API_BASE, auth);
  const accountId = (name: string) => accounts.find((a) => a.name === name)!.id;
  const bank = accountId("Bank Account");

  const item = await createItemViaApi(API_BASE, auth, {
    name: "Audit Widget",
    type: "service",
    sellPrice: 120,
    costPrice: 60,
  });
  const customer = await createCustomerViaApi(API_BASE, auth, {
    displayName: "Audit Customer",
  });
  const vendor = await createVendorViaApi(API_BASE, auth, {
    displayName: "Audit Vendor",
  });
  const entries = [{ index: 1, itemId: item.id, rate: 120, quantity: 2 }];

  const invoice = await createDeliveredInvoiceViaApi(API_BASE, auth, {
    customerId: customer.id,
    itemId: item.id,
    rate: 120,
    quantity: 2,
  });
  const bill = await createOpenedBillViaApi(API_BASE, auth, {
    vendorId: vendor.id,
    itemId: item.id,
    rate: 60,
    quantity: 3,
    billNumber: "AUDIT-BILL-1",
  });
  await createExpenseViaApi(API_BASE, auth, {
    referenceNo: "AUDIT-EXP-1",
    amount: 250,
    description: "Audit expense",
    expenseAccountName: "Office expenses",
    paymentAccountName: "Bank Account",
    paymentDate: today(),
  } as any);
  await createManualJournalViaApi(API_BASE, auth, {
    date: today(),
    journalNumber: "AUDIT-MJ-1",
    referenceNo: "AUDIT-MJ-1",
    description: "Audit journal",
    entries: [
      { accountId: bank, debit: 500, note: "debit" },
      {
        accountId: accountId("Opening Balance Equity"),
        credit: 500,
        note: "credit",
      },
    ],
  });
  await post("/sale-receipts", {
    customerId: customer.id,
    depositAccountId: bank,
    receiptDate: today(),
    closed: true,
    entries,
  });
  await post("/sale-estimates", {
    customerId: customer.id,
    estimateDate: today(),
    expirationDate: today(),
    delivered: true,
    entries,
  });
  await post("/credit-notes", {
    customerId: customer.id,
    creditNoteDate: today(),
    open: true,
    entries,
  });
  await post("/vendor-credits", {
    vendorId: vendor.id,
    vendorCreditDate: today(),
    open: true,
    entries,
  });
  const invoiceId = invoice?.id ?? invoice?.data?.id;
  if (invoiceId) {
    await post("/payments-received", {
      customerId: customer.id,
      paymentDate: today(),
      depositAccountId: bank,
      entries: [{ index: 1, invoiceId, paymentAmount: 50 }],
    });
  }
  const billId = bill?.id ?? bill?.data?.id;
  if (billId) {
    await post("/bill-payments", {
      vendorId: vendor.id,
      paymentDate: today(),
      paymentAccountId: bank,
      entries: [{ billId, paymentAmount: 30 }],
    });
  }

  // Sales/Purchases by Items list inventory items only.
  const stockItem = await createItemViaApi(API_BASE, auth, {
    name: "Audit Stock Item",
    type: "inventory",
    sellPrice: 90,
    costPrice: 40,
  });
  await createOpenedBillViaApi(API_BASE, auth, {
    vendorId: vendor.id,
    itemId: stockItem.id,
    rate: 40,
    quantity: 5,
    billNumber: "AUDIT-BILL-2",
  });
  await createDeliveredInvoiceViaApi(API_BASE, auth, {
    customerId: customer.id,
    itemId: stockItem.id,
    rate: 90,
    quantity: 2,
  });

  // A foreign-currency vendor with an opening balance shows the exchange-rate
  // line in its "Edit opening balance" dialog.
  const currencies = await fetch(`${API_BASE}/api/currencies`, {
    headers: {
      authorization: `Bearer ${auth.accessToken}`,
      "organization-id": auth.organizationId,
    },
  })
    .then((res) => res.json())
    .catch(() => []);
  const list = Array.isArray(currencies) ? currencies : currencies?.data ?? [];
  if (!list.some((c: any) => (c.currencyCode ?? c.currency_code) === "USD")) {
    await post("/currencies", {
      currencyCode: "USD",
      currencyName: "US Dollar",
      currencySign: "$",
    });
  }
  await post("/vendors", {
    displayName: "Audit USD Vendor",
    currencyCode: "USD",
    openingBalance: 100,
    openingBalanceExchangeRate: 3.67,
    openingBalanceAt: today(),
  });

  // An imported bank-statement line that matches the 50.00 payment above, so
  // the bank "match" panel has an item to select.
  await importCsv(
    "uncategorized_bank_transaction",
    `Date,Payee,Description,Reference No.,Amount\n${today()},Audit Customer,Audit deposit,AUDIT-DEP-1,50\n`,
    [
      { from: "Date", to: "date" },
      { from: "Payee", to: "payee" },
      { from: "Description", to: "description" },
      { from: "Reference No.", to: "referenceNo" },
      { from: "Amount", to: "amount" },
    ],
    { accountId: bank },
  );
  return { bankAccountId: bank };
}

async function open(page: Page, route: string, theme: string) {
  await page.addInitScript((t) => localStorage.setItem("theme", t), theme);
  await page.goto(route, { waitUntil: "domcontentloaded" });
  await page
    .getByTestId("dashboard-topbar")
    .or(page.locator(".preferences-page"))
    .first()
    .waitFor({ timeout: 60_000 })
    .catch(() => undefined);
  await page.addStyleTag({
    content:
      "*,*::before,*::after{transition:none!important;animation:none!important}",
  });
  await page
    .waitForLoadState("networkidle", { timeout: 8_000 })
    .catch(() => undefined);
  await page.waitForTimeout(800);
}

async function audit(page: Page, key: string, greyTotalRules = false) {
  const theme = key.startsWith("dark") ? "dark" : "light";
  const issues = [
    ...(await findLowContrastText(page)),
    ...(await findWrongThemeSurfaces(page, theme)),
    ...(await findBorderIssues(page, theme, greyTotalRules)),
    ...(await findUnreadableDisabledButtons(page)),
  ];
  fs.writeFileSync(
    path.join(OUT, `${key}.json`),
    JSON.stringify(issues, null, 2),
  );
  await page.screenshot({ path: path.join(OUT, `${key}.png`) });
}

test.beforeAll(async () => {
  test.setTimeout(10 * 60_000);
  fs.mkdirSync(OUT, { recursive: true });
  // Workers restart after a failure; seed only once per run.
  if (!fs.existsSync(seedInfoPath())) {
    const info = await seed();
    fs.writeFileSync(seedInfoPath(), JSON.stringify(info));
  }
});

for (const theme of THEMES) {
  for (const route of PAGES) {
    test(`${theme} ${route}`, async ({ page }) => {
      await open(page, route, theme);
      await audit(
        page,
        `${theme}__${slug(route)}`,
        GREY_TOTAL_RULE_REPORTS.includes(route),
      );
    });
  }

  for (const route of DRAWERS) {
    test(`${theme} drawer ${route}`, async ({ page }) => {
      await open(page, route, theme);
      const cell = page.locator(".tbody .tr .td").nth(2);
      await cell.waitFor({ timeout: 20_000 });
      await cell.click();
      const drawer = page.locator(".bp4-drawer").first();
      await drawer.waitFor({ timeout: 20_000 });
      await page
        .waitForLoadState("networkidle", { timeout: 8_000 })
        .catch(() => undefined);
      await page.waitForTimeout(800);
      await audit(page, `${theme}__drawer_${slug(route)}`);

      // Visit every tab of the drawer (details, GL entries, transactions...).
      const tabs = drawer.locator(".bp4-tab-list > .bp4-tab");
      const count = await tabs.count();
      for (let i = 1; i < count; i++) {
        await tabs.nth(i).click();
        await page
          .waitForLoadState("networkidle", { timeout: 8_000 })
          .catch(() => undefined);
        await page.waitForTimeout(600);
        await audit(page, `${theme}__drawer_${slug(route)}__tab${i}`);
      }
    });
  }
}

/** Right-clicks the first table row and picks an item from its menu. */
async function rowMenu(page: Page, item: string, row = page.locator(".tbody .tr").first()) {
  await row.waitFor({ timeout: 20_000 });
  await row.click({ button: "right" });
  await page.locator(".bp4-menu").getByText(item, { exact: true }).click();
  await page.locator(".bp4-dialog").first().waitFor({ timeout: 20_000 });
}

/** Opens a list page's "Customize Templates" and its first template. */
async function openCustomizeTemplate(page: Page) {
  await page.locator('.dashboard__actions-bar .bp4-button:has([data-icon="cog-16"])').click();
  await page.getByText(/^Customize Templates?$/).click();
  const row = page.locator(".bp4-drawer .tbody .tr").first();
  await row.waitFor({ timeout: 20_000 });
  await row.locator(".td").first().click();
  // The paper preview's big title ("Invoice", "Estimate", ...).
  await page.locator(".bp4-drawer h1").first().waitFor({ timeout: 20_000 });
}

/** Ticks the first row's checkbox so the bulk-actions toolbar shows. */
async function selectFirstRow(page: Page) {
  const checkbox = page.locator(".tbody .tr").first().locator(".bp4-checkbox");
  await checkbox.waitFor({ timeout: 20_000 });
  await checkbox.click();
}

/** Popovers, menus, dialogs and secondary drawers reached through UI actions. */
const INTERACTIONS: Array<
  [string, string | (() => string), (page: Page) => Promise<void>]
> = [
  [
    "invoice_send_mail",
    "/invoices",
    async (page) => {
      await page.locator(".tbody .tr .td").nth(2).click();
      await page.locator(".bp4-drawer").getByText("Send Mail").click();
    },
  ],
  [
    "invoices_filter",
    "/invoices",
    async (page) => {
      await page
        .getByRole("button", { name: /Filter/ })
        .first()
        .click();
    },
  ],
  [
    "quick_new_menu",
    "/",
    async (page) => {
      await page.getByText("Quick new").first().click();
    },
  ],
  [
    "user_menu",
    "/",
    async (page) => {
      await page.locator(".bp4-button:has(.user-text)").first().click();
    },
  ],
  // T1: changing a tax rate shows a "Please note" warning.
  [
    "tax_rate_edit_warning",
    "/tax-rates",
    async (page) => {
      await rowMenu(page, "Edit Tax Rate");
      await page.locator('.bp4-dialog input[name="rate"]').fill("7");
      await page.getByText("Please Note:").waitFor({ timeout: 10_000 });
    },
  ],
  // T2: "remaining credit" in the reconcile dialogs.
  [
    "reconcile_credit_note",
    "/credit-notes",
    async (page) => rowMenu(page, "Reconcile with Invoices"),
  ],
  [
    "reconcile_vendor_credit",
    "/vendor-credits",
    async (page) => rowMenu(page, "Reconcile with Bills"),
  ],
  // T3: the shared "1 USD = X AED" exchange-rate line.
  [
    "vendor_opening_balance_exchange_rate",
    "/vendors",
    async (page) => {
      await page
        .locator(".tbody .tr", { hasText: "Audit USD Vendor" })
        .locator(".td")
        .nth(2)
        .click();
      const drawer = page.locator(".bp4-drawer").first();
      await drawer.locator('.bp4-button:has([data-icon="more-vert"])').click();
      await page.getByText("Edit Opening Balance").click();
      await page.locator(".bp4-dialog").getByText(/^1 /).first().waitFor({
        timeout: 20_000,
      });
    },
  ],
  // T5: a selected item in the bank "match" panel.
  [
    "bank_match_selected",
    () =>
      `/cashflow-accounts/${readSeedInfo().bankAccountId}/transactions?filter=uncategorized`,
    async (page) => {
      await page.locator(".tbody .tr .td").nth(2).click();
      await page.getByRole("tab", { name: "Matching Transaction" }).click();
      // Each match item shows "Date: ..."; clicking it selects the item.
      await page.getByText(/^Date: /).first().click();
    },
  ],
  // T7: the bulk delete dialog's note divider.
  [
    "bulk_delete_dialog",
    "/invoices",
    async (page) => {
      await selectFirstRow(page);
      await page.locator(".dashboard__actions-bar").getByText("Delete").click();
      await page.locator(".bp4-dialog").first().waitFor({ timeout: 20_000 });
    },
  ],
  // T8: the bulk Delete button is disabled while the server checks the
  // selection. Hold that check so the disabled state can be measured.
  [
    "toolbar_disabled_delete",
    "/invoices",
    async (page) => {
      await page.route("**/validate-bulk-delete**", () => undefined);
      await selectFirstRow(page);
      await page.locator(".dashboard__actions-bar").getByText("Delete").click();
      await page
        .locator(".dashboard__actions-bar .bp4-button.bp4-disabled")
        .waitFor({ timeout: 10_000 });
    },
  ],
  // T8: no toolbar keeps a plain (non-danger) button disabled for long, so
  // disable one the way Blueprint does to measure the toolbar's own style.
  [
    "toolbar_disabled_button",
    "/invoices",
    async (page) => {
      await page.evaluate(() => {
        const button = Array.from(
          document.querySelectorAll(".dashboard__actions-bar .bp4-button"),
        ).find((b) => (b.textContent || "").trim() && !b.className.includes("intent"));
        button?.classList.add("bp4-disabled");
        button?.setAttribute("disabled", "");
      });
    },
  ],
  // T9: muted text on the white "paper" of the customization previews.
  ...(
    [
      ["invoice", "/invoices"],
      ["estimate", "/estimates"],
      ["receipt", "/receipts"],
      ["credit_note", "/credit-notes"],
    ] as const
  ).map(
    ([name, route]) =>
      [
        `${name}_customize_preview`,
        route,
        async (page: Page) => openCustomizeTemplate(page),
      ] as [string, string, (page: Page) => Promise<void>],
  ),
  [
    "invoice_customize_payment_page",
    "/invoices",
    async (page) => {
      await openCustomizeTemplate(page);
      await page.getByText("Payment page").click();
    },
  ],
];

for (const theme of THEMES) {
  for (const [name, route, act] of INTERACTIONS) {
    test(`${theme} interaction ${name}`, async ({ page }) => {
      await open(page, typeof route === "function" ? route() : route, theme);
      await act(page);
      await page
        .waitForLoadState("networkidle", { timeout: 8_000 })
        .catch(() => undefined);
      await page.waitForTimeout(1_000);
      await audit(page, `${theme}__ui_${name}`);
    });
  }
}
