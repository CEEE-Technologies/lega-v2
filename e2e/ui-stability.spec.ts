import { test, expect as baseExpect } from "@playwright/test";
import { createOnboardedUser } from "./_auth";

// Allow cold Vite module loading before asserting interactive UI.
const expect = baseExpect.configure({ timeout: 20_000 });

test("company icon keeps a stable pointer and hit area while its tooltip opens", async ({
  page,
}) => {
  await page.goto("/");
  const icon = page.locator('.workspaces-sidebar__item[aria-current="true"]');
  await expect(icon).toBeVisible();
  await expect(page.getByRole("status", { name: "Loading LEGA" })).toHaveCount(
    0,
  );
  const box = (await icon.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await expect(page.locator(".bp4-tooltip")).toBeVisible();
  const samples = await page.evaluate(
    async ({ x, y }) => {
      const results = [];
      for (let index = 0; index < 20; index++) {
        const el = document.elementFromPoint(x, y)!;
        results.push({
          cursor: getComputedStyle(el).cursor,
          button: !!el.closest("button"),
        });
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return results;
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
  expect(
    samples.every((sample) => sample.cursor === "pointer" && sample.button),
  ).toBe(true);
  await expect(icon).toHaveCSS("transform", "none");
});

test("create company uses the viewport and keeps actions accessible from other pages", async ({
  page,
}) => {
  for (const height of [984, 600]) {
    await page.setViewportSize({ width: 1280, height });
    await page.goto(height === 984 ? "/preferences/general" : "/invoices");
    await expect(
      page.getByRole("status", { name: "Loading LEGA" }),
    ).toHaveCount(0);
    await page.evaluate((shortWindow) => {
      window.legaTheme.set(shortWindow ? "dark" : "light");
      document.documentElement.dir = shortWindow ? "rtl" : "ltr";
    }, height === 600);
    await page.getByTestId("create-company").click();
    const drawer = page.locator(".bp4-drawer");
    await expect(
      page.getByRole("heading", { name: "Create New Workspace" }),
    ).toBeVisible();
    await expect
      .poll(async () => Math.round((await drawer.boundingBox())!.height))
      .toBe(height);
    const submit = drawer.getByRole("button", {
      name: "Create Workspace",
      exact: true,
    });
    const box = (await submit.boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(height);
    await drawer
      .getByRole("button", { name: "Select Time Zone..." })
      .scrollIntoViewIfNeeded();
    await expect(submit).toBeInViewport();
    await drawer.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(drawer).toHaveCount(0);
  }
});

test("refresh retains one loading presentation until all boot requests finish", async ({
  page,
}) => {
  for (const navigation of ["open", "refresh"]) {
    let releaseAuth!: () => void;
    let releaseDashboard!: () => void;
    const authGate = new Promise<void>((resolve) => {
      releaseAuth = resolve;
    });
    const dashboardGate = new Promise<void>((resolve) => {
      releaseDashboard = resolve;
    });
    await page.route("**/api/auth/meta", async (route) => {
      await authGate;
      await route.continue();
    });
    await page.route("**/api/dashboard/boot", async (route) => {
      await dashboardGate;
      await route.continue();
    });
    if (navigation === "open") await page.goto("/");
    else await page.reload();
    const splash = page.getByRole("status", { name: "Loading LEGA" });
    await expect(splash).toBeVisible();
    const initialSplash = (await splash.elementHandle())!;
    await page.waitForTimeout(1000);
    await expect(splash).toHaveCSS("opacity", "1");
    const dashboardRequested = page.waitForRequest("**/api/dashboard/boot");
    releaseAuth();
    await dashboardRequested;
    await page.waitForTimeout(300);
    expect(await initialSplash.evaluate((el) => el.isConnected)).toBe(true);
    await expect(splash).toHaveCSS("opacity", "1");
    await expect(page.locator(".App")).not.toContainText("Loading...");
    releaseDashboard();
    await expect(page.getByTestId("company-sidebar")).toBeVisible();
    await expect(splash).toHaveCount(0);
    await page.unroute("**/api/auth/meta");
    await page.unroute("**/api/dashboard/boot");
  }
});

test.describe("booting after login", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test("shows loading again during a subsequent authenticated boot", async ({
    page,
  }) => {
    const session = await createOnboardedUser(
      process.env.PLAYWRIGHT_TEST_API_URL || "http://localhost:3000",
    );
    await page.goto("/auth/login");
    await expect(
      page.getByRole("status", { name: "Loading LEGA" }),
    ).toHaveCount(0);
    await page
      .getByLabel("Email Address", { exact: true })
      .fill(session.credentials.email);
    await page
      .getByLabel("Password", { exact: true })
      .fill(session.credentials.password);
    let releaseDashboard!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseDashboard = resolve;
    });
    await page.route("**/api/dashboard/boot", async (route) => {
      await gate;
      await route.continue();
    });
    const bootRequested = page.waitForRequest("**/api/dashboard/boot");
    await page.getByRole("button", { name: "Log in", exact: true }).click();
    await bootRequested;
    await expect(
      page.getByRole("status", { name: "Loading LEGA" }),
    ).toBeVisible();
    await page.waitForTimeout(300);
    await expect(page.getByRole("status", { name: "Loading LEGA" })).toHaveCSS(
      "opacity",
      "1",
    );
    releaseDashboard();
    await expect(page.getByTestId("company-sidebar")).toBeVisible();
    await expect(
      page.getByRole("status", { name: "Loading LEGA" }),
    ).toHaveCount(0);
  });
});
