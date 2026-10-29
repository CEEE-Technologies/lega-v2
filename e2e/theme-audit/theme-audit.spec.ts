/**
 * Visits every main screen in light and dark theme, opens record detail
 * drawers, and reports text that is unreadable against its background.
 *
 * Run: pnpm exec playwright test -c playwright.theme-audit.config.ts
 * Report: test-results/theme-audit/<theme>__<page>.json (+ screenshots).
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
import { findLowContrastText, findWrongThemeSurfaces } from "./contrast";

const API_BASE = process.env.PLAYWRIGHT_TEST_API_URL || "http://localhost:3000";
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

const today = () => new Date().toISOString().slice(0, 10);

async function seed() {
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

async function audit(page: Page, key: string) {
  const theme = key.startsWith("dark") ? "dark" : "light";
  const issues = [
    ...(await findLowContrastText(page)),
    ...(await findWrongThemeSurfaces(page, theme)),
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
  const marker = path.join(OUT, `.seeded-${readApiAuth().organizationId}`);
  if (!fs.existsSync(marker)) {
    await seed();
    fs.writeFileSync(marker, "");
  }
});

for (const theme of THEMES) {
  for (const route of PAGES) {
    test(`${theme} ${route}`, async ({ page }) => {
      await open(page, route, theme);
      await audit(page, `${theme}__${slug(route)}`);
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

/** Popovers, menus and secondary drawers reached through UI actions. */
const INTERACTIONS: Array<[string, string, (page: Page) => Promise<void>]> = [
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
];

for (const theme of THEMES) {
  for (const [name, route, act] of INTERACTIONS) {
    test(`${theme} interaction ${name}`, async ({ page }) => {
      await open(page, route, theme);
      await act(page);
      await page
        .waitForLoadState("networkidle", { timeout: 8_000 })
        .catch(() => undefined);
      await page.waitForTimeout(1_000);
      await audit(page, `${theme}__ui_${name}`);
    });
  }
}
