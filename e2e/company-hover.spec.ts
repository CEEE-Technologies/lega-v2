import { test, expect } from "@playwright/test";

test("company hover stays stable across corners, content and tooltip opening", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.goto("/");
  const button = page.locator('.workspaces-sidebar__item[aria-current="true"]');
  await expect(button).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("status", { name: "Loading LEGA" })).toHaveCount(
    0,
    { timeout: 30_000 },
  );
  const box = (await button.boundingBox())!;
  const positions = [
    { x: box.x + 1, y: box.y + 1 },
    { x: box.x + box.width - 2, y: box.y + 1 },
    { x: box.x + box.width - 2, y: box.y + box.height - 2 },
    { x: box.x + 1, y: box.y + box.height - 2 },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  ];
  const observations = [];
  for (const point of positions) {
    await page.mouse.move(point.x, point.y);
    observations.push(
      await page.evaluate(async ({ x, y }) => {
        const samples = [];
        for (let i = 0; i < 12; i++) {
          const el = document.elementFromPoint(x, y)!;
          const popup = document.querySelector(".workspaces-sidebar-tooltip");
          samples.push({
            cursor: getComputedStyle(el).cursor,
            cls: el.className,
            target: !!el.closest(".workspaces-sidebar__item-tooltip"),
            popup: popup ? popup.getBoundingClientRect().toJSON() : null,
          });
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        return samples;
      }, point),
    );
  }
  expect(observations.flat().map((sample) => sample.cursor)).toEqual(
    Array(60).fill("pointer"),
  );
  expect(observations.flat().every((sample) => sample.target)).toBe(true);
  await expect(page.locator(".workspaces-sidebar-tooltip")).toBeVisible();
});

test("company tooltip stays left of the rail instead of covering its own trigger", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  const button = page.locator('.workspaces-sidebar__item[aria-current="true"]');
  await expect(button).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("status", { name: "Loading LEGA" })).toHaveCount(
    0,
    { timeout: 30_000 },
  );
  await button.hover();
  const tooltip = page.locator(".workspaces-sidebar-tooltip");
  await expect(tooltip).toBeVisible();
  const box = (await button.boundingBox())!;
  await expect
    .poll(async () => {
      const popup = (await tooltip.boundingBox())!;
      return popup.x + popup.width <= box.x;
    })
    .toBe(true);
  await page.screenshot({
    path: testInfo.outputPath("company-tooltip.png"),
    clip: { x: 0, y: 0, width: 1280, height: 160 },
  });
});
