import { expect, test } from "@playwright/test";

test("seed: public login page renders", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("STAX");
  await expect(page.getByPlaceholder("name@company.com")).toBeVisible();
  await expect(page.getByRole("button", { name: "เข้าสู่ระบบ" })).toBeVisible();
});