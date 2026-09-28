// spec: specs/stax-delta-authenticated-dashboard.plan.md
// seed: tests/seed.spec.ts

import { expect, test } from "@playwright/test";

const appUrl = process.env.STAX_BASE_URL;
if (!appUrl) {
  throw new Error("STAX_BASE_URL is required to run the authenticated STAX dashboard test.");
}
const metricLabels = ["มูลค่ารวม", "เงินสดรวม", "มูลค่าเงินลงทุน", "กำไร/ขาดทุนสะสม"] as const;

async function readMetric(page: import("@playwright/test").Page, label: string) {
  const labelLocator = page.getByText(label, { exact: false }).first();
  await expect(labelLocator).toBeVisible();
  const metricCard = labelLocator.locator("xpath=ancestor::div[contains(@class, 'p-4')][1]");
  const cardText = (await metricCard.innerText()).replace(/\s+/g, " ").trim();
  const value = cardText.match(/฿\s*-?[\d,]+\.\d{2}/)?.[0];
  expect(value, `Expected a THB amount for dashboard metric ${label}`).toBeTruthy();
  return { cardText, value: value!.replace(/\s+/g, "") };
}

async function readSection(page: import("@playwright/test").Page, heading: string) {
  const title = page.getByRole("heading", { name: heading, exact: true });
  await expect(title).toBeVisible();
  const section = title.locator("xpath=ancestor::section[1]");
  return (await section.innerText()).replace(/\s+/g, " ").trim();
}

async function readExchangeRows(page: import("@playwright/test").Page) {
  await expect(page.getByRole("heading", { name: "การแลกเปลี่ยนสกุลเงิน", exact: true })).toBeVisible();
  const table = page.getByRole("table").last();
  for (const header of ["วันที่", "ทิศทาง", "จำนวนเงินต้นทาง", "จำนวนเงินปลายทาง", "อัตร"]) {
    await expect(table.getByRole("columnheader", { name: new RegExp(header) })).toBeVisible();
  }

  const rows = await table.getByRole("row").allInnerTexts();
  const dataRows = rows.slice(1).map((row) => row.replace(/\s+/g, " ").trim());
  expect(dataRows.length, "The exchange table should contain existing FX data").toBeGreaterThan(0);
  for (const row of dataRows) {
    expect(row).toContain("→");
    expect(row).toMatch(/\b[A-Z]{3}\b/);
  }
  return dataRows;
}

test.describe("Authenticated dashboard and currency exchange consistency", () => {
  test("Verify existing dashboard and FX data remain consistent after navigation", async ({ page }) => {
    // 1. Open the configured login page and verify its public form.
    await page.goto(appUrl);
    await expect(page).toHaveTitle("STAX");
    await expect(page.getByRole("textbox", { name: "name@company.com" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "••••••••" })).toBeVisible();
    await expect(page.getByRole("button", { name: "เข้าสู่ระบบ" })).toBeVisible();

    // 2. Sign in using only the configured process environment credentials.
    const email = process.env.STAX_TEST_EMAIL;
    const password = process.env.STAX_TEST_PASSWORD;
    if (!email || !password) {
      throw new Error("Set STAX_TEST_EMAIL and STAX_TEST_PASSWORD in the test process environment.");
    }
    await page.getByRole("textbox", { name: "name@company.com" }).fill(email);
    await page.getByRole("textbox", { name: "••••••••" }).fill(password);
    const dashboardNavigation = page.waitForURL(/\/dashboard(?:[/?#]|$)/, { timeout: 10_000 });
    await page.getByRole("button", { name: "เข้าสู่ระบบ" }).click();
    await dashboardNavigation;
    await expect(page).toHaveURL(/\/dashboard(?:[/?#]|$)/);
    await expect(page.getByText(email, { exact: true }).first()).toBeVisible();
    const authenticatedEmail = await page.evaluate(() => {
      const storedUser = localStorage.getItem("stax_auth_user");
      return storedUser ? (JSON.parse(storedUser) as { email?: string }).email : null;
    });
    expect(authenticatedEmail).toBe(email);

    // 3. Capture the existing financial summary and relevant dashboard data.
    await expect(page.getByRole("heading", { name: /^ยินดีต้อนรับ/ })).toBeVisible();
    const initialMetrics: Record<string, string> = {};
    for (const label of metricLabels) {
      initialMetrics[label] = (await readMetric(page, label)).value;
    }
    const initialDashboardSections = {
      ledgerSummary: await readSection(page, "สรุปงบการเงิน"),
      holdings: await readSection(page, "การถือครองหุ้น"),
      cashMovements: await readSection(page, "สรุปเงินเข้า/ออก"),
    };

    // 4. Open the existing currency exchange records and capture their rows.
    await page.getByRole("navigation").getByRole("button", { name: "เงินเข้า/ออก", exact: true }).click();
    await page.getByRole("button", { name: "แลกเปลี่ยนสกุลเงิน", exact: true }).click();
    const initialExchangeRows = await readExchangeRows(page);

    // 5. Return to the dashboard and ensure navigation did not change existing data.
    await page.getByRole("button", { name: /หน้าหลัก/ }).click();
    await expect(page).toHaveURL(/\/dashboard(?:[/?#]|$)/);
    await expect(page.getByRole("heading", { name: /^ยินดีต้อนรับ/ })).toBeVisible();
    for (const label of metricLabels) {
      const revisited = await readMetric(page, label);
      expect(revisited.value).toBe(initialMetrics[label]);
    }
    await expect(await readSection(page, "สรุปงบการเงิน")).toBe(initialDashboardSections.ledgerSummary);
    await expect(await readSection(page, "การถือครองหุ้น")).toBe(initialDashboardSections.holdings);
    await expect(await readSection(page, "สรุปเงินเข้า/ออก")).toBe(initialDashboardSections.cashMovements);

    // 6. Revisit the exchange view and verify its existing rows were not duplicated or changed.
    await page.getByRole("navigation").getByRole("button", { name: "เงินเข้า/ออก", exact: true }).click();
    await page.getByRole("button", { name: "แลกเปลี่ยนสกุลเงิน", exact: true }).click();
    expect(await readExchangeRows(page)).toEqual(initialExchangeRows);
  });
});
