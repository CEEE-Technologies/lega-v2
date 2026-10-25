import { test, expect as baseExpect } from "@playwright/test";
import { readApiAuth } from "./_api";

// Allow cold Vite module loading before asserting interactive UI.
const expect = baseExpect.configure({ timeout: 20_000 });

test.describe("LEGA public branding and themes", () => {
  test.use({ storageState: { cookies: [], origins: [] }, colorScheme: "dark" });

  test("starts light on a dark OS and has no upstream product links", async ({
    page,
  }) => {
    await page.goto("/auth/login");
    await expect(
      page.getByRole("button", { name: "Log in", exact: true }),
    ).toBeVisible();
    await expect(page).toHaveTitle("LEGA");
    await expect(page.locator("html")).not.toHaveClass(/bp4-dark/);
    await expect(page.locator("body")).not.toHaveClass(/bp4-dark/);
    await expect(
      page.getByRole("img", { name: "LEGA", exact: true }).first(),
    ).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/bigcapital/i);
    await expect(
      page.locator('a[href*="bigcapital"], a[href*="discord.com"]'),
    ).toHaveCount(0);
  });

  test("restores saved dark mode with LEGA surfaces", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("theme", "dark"));
    await page.goto("/auth/login");
    await expect(
      page.getByRole("button", { name: "Log in", exact: true }),
    ).toBeVisible();
    await expect(page.locator("html")).toHaveClass(/bp4-dark/);
    await expect(page.locator("body")).toHaveClass(/bp4-dark/);
    expect(
      await page
        .locator("body")
        .evaluate((body) =>
          getComputedStyle(body).getPropertyValue("--color-primary").trim(),
        ),
    ).toBe("#78c3ad");
    await page.reload();
    await expect(page.locator("body")).toHaveClass(/bp4-dark/);
  });

  test("payment pages remain light and preserve merchant identity and saved preference", async ({
    page,
  }) => {
    await page.addInitScript(() => localStorage.setItem("theme", "dark"));
    await page.route("**/api/payment-links/branding-test/invoice", (route) =>
      route.fulfill({
        json: {
          organization: { name: "Merchant Example" },
          invoice_no: "INV-EXAMPLE",
          total_formatted: "$120.00",
          subtotal_formatted: "$120.00",
          due_amount_formatted: "$120.00",
          customer_name: "Example Customer",
          branding_template: {},
          entries: [],
        },
      }),
    );
    await page.goto("/payment/branding-test");
    await expect(
      page.getByRole("heading", { name: /Merchant Example Sent an Invoice/ }),
    ).toBeVisible();
    await expect(page.locator("html")).not.toHaveClass(/bp4-dark/);
    await expect(page.locator("body")).not.toHaveClass(/bp4-dark/);
    expect(await page.evaluate(() => localStorage.getItem("theme"))).toBe(
      "dark",
    );
    await expect(page.locator("body")).not.toContainText(
      /bigcapital|Example Company/,
    );
  });

  test("primary button variants retain LEGA colors in interactive states", async ({
    page,
  }) => {
    await page.goto("/auth/login");
    const button = page.getByRole("button", { name: "Log in", exact: true });
    await expect(button).toBeVisible();
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((value) => window.legaTheme.set(value), theme);
      const foreground =
        theme === "dark" ? "rgb(120, 195, 173)" : "rgb(31, 111, 92)";
      for (const variant of ["bp4-minimal", "bp4-outlined"]) {
        // Blueprint variants are classes on the same production button element.
        await button.evaluate((el, value) => {
          el.classList.remove("bp4-minimal", "bp4-outlined");
          el.classList.add(value);
        }, variant);
        await button.hover();
        await expect(button).toHaveCSS("color", foreground);
        await button.evaluate((el) => el.classList.add("bp4-active"));
        await expect(button).toHaveCSS("color", foreground);
        await button.evaluate((el) => {
          el.classList.remove("bp4-active");
          el.setAttribute("disabled", "");
        });
        await expect(button).toHaveCSS("color", foreground);
        await button.evaluate((el) => el.removeAttribute("disabled"));
      }
    }
  });
});

test.describe("LEGA dashboard layout", () => {
  test("company rail handles many companies, long names, logos and unavailable states", async ({
    page,
    request,
  }) => {
    const auth = readApiAuth();
    const response = await request.get("/api/workspaces", {
      headers: {
        authorization: `Bearer ${auth.accessToken}`,
        "organization-id": auth.organizationId,
      },
    });
    expect(response.ok()).toBeTruthy();
    const existing = await response.json();
    const template = existing[0];
    const longName =
      "A company with a deliberately long name for the compact rail";
    const companies = Array.from({ length: 12 }, (_, index) => ({
      ...template,
      organization_id: `fixture-${index}`,
      is_ready: index !== 1,
      is_active: index !== 2,
      is_build_running: index === 3,
      is_deleting: index === 4,
      metadata: {
        ...template.metadata,
        name: index === 0 ? longName : `Fixture company ${index}`,
        logo_uri: index === 0 ? "/brand/lega-logo.png" : undefined,
      },
    }));
    await page.route("**/api/workspaces?*", (route) =>
      route.fulfill({ json: [template, ...companies] }),
    );
    await page.goto("/");
    await expect(page.getByTestId("company-sidebar")).toBeVisible();
    await expect(
      page.getByRole("button", { name: longName, exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByTestId("company-fixture-0").getByRole("img"),
    ).toHaveAttribute("alt", longName);
    for (const index of [1, 2, 3, 4])
      await expect(page.getByTestId(`company-fixture-${index}`)).toBeDisabled();
    await page.getByTestId("company-fixture-11").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("company-fixture-11")).toBeVisible();
    await expect(page.getByTestId("all-companies")).toBeVisible();
    await expect(page.getByTestId("create-company")).toBeVisible();
  });

  test("right company rail survives collapse, resizing, and preferences", async ({
    page,
  }) => {
    await page.goto("/");
    const rail = page.getByTestId("company-sidebar");
    await expect(rail).toBeVisible();
    await expect(
      page.getByRole("link", { name: "LEGA home", exact: true }).first(),
    ).toBeVisible();
    const bounds = await rail.boundingBox();
    expect(bounds?.width).toBe(48);
    expect(bounds!.x + bounds!.width).toBe(page.viewportSize()!.width);
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    await expect(rail).toBeVisible();
    await page.getByTestId("all-companies").click();
    await expect(
      page.getByRole("heading", { name: /Workspaces/ }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Close", exact: true })
      .last()
      .click();
    await page.goto("/preferences/general");
    await expect(rail).toBeVisible();
    await expect(page.getByTestId("current-company")).not.toBeEmpty();
    const prefBounds = await rail.boundingBox();
    expect(prefBounds!.x + prefBounds!.width).toBe(page.viewportSize()!.width);
  });

  test("account menu and shortcut persist a synchronized theme", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.getByTestId("company-sidebar")).toBeVisible();
    await page.keyboard.press("Shift+H");
    await expect(page.locator("html")).toHaveClass(/bp4-dark/);
    await expect(page.locator("body")).toHaveClass(/bp4-dark/);
    await page.reload();
    await expect(page.getByTestId("company-sidebar")).toBeVisible();
    await expect(page.locator("body")).toHaveClass(/bp4-dark/);
    await page.locator(".dashboard__topbar-user button").click();
    await page.getByText("Switch to light mode", { exact: true }).click();
    await expect(page.locator("html")).not.toHaveClass(/bp4-dark/);
    await expect(page.locator("body")).not.toHaveClass(/bp4-dark/);
    expect(await page.evaluate(() => localStorage.getItem("theme"))).toBe(
      "light",
    );
  });

  test("switches companies without leaking cached customer data and keeps RTL rail right", async ({
    page,
    request,
  }) => {
    test.setTimeout(180_000);
    const auth = readApiAuth();
    const headers = {
      authorization: `Bearer ${auth.accessToken}`,
      "organization-id": auth.organizationId,
    };
    const suffix = Date.now();
    const customerName = `Original customer ${suffix}`;
    const customer = await request.post("/api/customers", {
      headers,
      data: {
        display_name: customerName,
        customer_type: "business",
        currency_code: "AED",
      },
    });
    expect(customer.ok()).toBeTruthy();
    const name = `LEGA RTL company ${suffix}`;
    const created = await request.post("/api/workspaces", {
      headers,
      data: {
        name,
        location: "AE",
        base_currency: "AED",
        timezone: "Asia/Dubai",
        fiscal_year: "january",
        language: "ar",
      },
    });
    expect(created.ok()).toBeTruthy();
    const company = await created.json();
    await expect
      .poll(
        async () => {
          const res = await request.get(
            `/api/workspaces/build/${company.job_id}`,
            { headers },
          );
          const body = await res.json();
          return body.is_completed;
        },
        { timeout: 120_000, intervals: [2000] },
      )
      .toBe(true);
    await page.goto("/customers");
    await expect(
      page.getByText(customerName, { exact: true }).first(),
    ).toBeVisible();
    await page.getByTestId(`company-${company.organization_id}`).click();
    await expect(page.getByTestId("current-company")).toHaveText(name, {
      timeout: 30_000,
    });
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    const rail = await page.getByTestId("company-sidebar").boundingBox();
    expect(rail!.x + rail!.width).toBe(page.viewportSize()!.width);
    await page.goto("/customers");
    await expect(page.getByTestId("company-sidebar")).toBeVisible();
    await expect(page.getByText(customerName, { exact: true })).toHaveCount(0);
    await page.getByTestId(`company-${auth.organizationId}`).click();
    await expect(page.getByTestId("company-sidebar")).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr", {
      timeout: 30_000,
    });
    await page.goto("/customers");
    await expect(
      page.getByText(customerName, { exact: true }).first(),
    ).toBeVisible();
  });
});
