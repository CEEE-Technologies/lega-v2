import { test, expect, type Page } from "@playwright/test";

/**
 * V3 (security round 3): the Stripe return page sends the connect `state`,
 * and the role pickers only offer "Admin" to admins.
 */

/** Makes the dashboard treat the signed-in user as a non-admin. */
async function actAsUserManager(page: Page) {
  await page.route("**/api/dashboard/boot", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.abilities = [
      { subject: "User", action: "Manage" },
      { subject: "Role", action: "View" },
    ];
    await route.fulfill({ response, json: body });
  });
}

/** Opens the invite dialog and the role picker; returns the option names. */
async function inviteRoleOptions(page: Page): Promise<string[]> {
  await page.goto("/preferences/users");
  await page.getByRole("button", { name: "Invite User" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 30_000 });

  // The role picker shows "Select an item ..." until a role is picked.
  await dialog.getByRole("button", { name: /Select an item/ }).click();

  const menu = page.locator(".bp4-popover .bp4-menu").last();
  await expect(menu).toBeVisible();
  return (await menu.getByRole("menuitem").allInnerTexts()).map((t) =>
    t.trim(),
  );
}

test.describe("security round 3 (V3)", () => {
  test("the Stripe return page sends the state; a forged one is refused", async ({
    page,
  }) => {
    const callback = page.waitForRequest(
      (req) =>
        req.url().includes("/api/stripe/callback") && req.method() === "POST",
    );
    await page.goto(
      "/preferences/payment-methods/stripe/callback?code=ac_attacker&state=forged",
    );
    const request = await callback;
    expect(request.postDataJSON()).toMatchObject({
      code: "ac_attacker",
      state: "forged",
    });
    await expect(
      page.getByText(
        "This Stripe connection wasn't started from your account.",
      ),
    ).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/preferences\/payment-methods$/);
  });

  test('an admin sees "Admin" in the invite role picker', async ({ page }) => {
    const options = await inviteRoleOptions(page);
    expect(options).toContain("Admin");
  });

  test('a non-admin does not see "Admin" in the invite role picker', async ({
    page,
  }) => {
    await actAsUserManager(page);
    const options = await inviteRoleOptions(page);
    expect(options.length).toBeGreaterThan(0);
    expect(options).not.toContain("Admin");
  });
});
