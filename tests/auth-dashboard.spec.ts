import { expect, test } from '@playwright/test';

const baseUrl = process.env.STAX_BASE_URL ?? '';
const testEmail = process.env.STAX_TEST_EMAIL;
const testPassword = process.env.STAX_TEST_PASSWORD;

test.use({ trace: 'off' });

function isNonProductionTargetConfigured(): boolean {
  if (!baseUrl) return false;

  try {
    return new URL(baseUrl).hostname !== 'stax-delta.vercel.app';
  } catch {
    return false;
  }
}

test.describe('Authentication and dashboard', () => {
  test('valid login and dashboard shell', async ({ page }) => {
    test.skip(
      !isNonProductionTargetConfigured(),
      'Set STAX_BASE_URL to a non-production test deployment; production authentication writes rate-limit/audit metadata.',
    );
    test.skip(!testEmail || !testPassword, 'Set STAX_TEST_EMAIL and STAX_TEST_PASSWORD to run this read-only scenario.');

    // 1. Open /login and sign in using the supplied environment credentials.
    await page.goto(`${baseUrl}/login`);
    await page.getByRole('textbox', { name: 'name@company.com' }).fill(testEmail!);
    await page.getByRole('textbox', { name: '••••••••' }).fill(testPassword!);
    await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();

    await expect(page).toHaveURL(/\/dashboard(?:\?.*)?$/);
    await expect(page.getByText(testEmail!, { exact: true }).first()).toBeVisible();

    for (const section of [
      'หน้าหลัก',
      'สมุดบันทึกการซื้อขาย',
      'สมุดรายวัน',
      'บัญชีแยกประเภท',
      'อัปโหลด Statement',
      'คลัง Statement',
      'เงินเข้า/ออก',
    ]) {
      await expect(page.getByText(section, { exact: true }).first()).toBeVisible();
    }

    // 2. Wait for dashboard widgets and toggle financial trend comparison.
    await expect(page.getByRole('heading', { name: 'สรุปงบการเงิน' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'สรุปสถานะการเงินรวม (Financial Position)' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'การถือครองหุ้น' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'สรุปเงินเข้า/ออก' })).toBeVisible();

    const metric = page
      .getByText('มูลค่ารวม (Net Financial Position)', { exact: true })
      .locator('..')
      .locator('p')
      .nth(1);
    await expect(metric).toHaveText(/\S/);
    const metricBeforeToggle = await metric.innerText();

    const comparisonToggle = page.getByRole('button', { name: /เปรียบเทียบเงินสด/ });
    await comparisonToggle.click();
    await expect(comparisonToggle).toContainText('เปิด');
    await expect(page.getByText('เงินสด (บาท)', { exact: true })).toBeVisible();
    await expect(metric).toHaveText(metricBeforeToggle);
  });

  test('invalid login remains unauthenticated', async ({ page }) => {
    test.skip(
      !isNonProductionTargetConfigured(),
      'Set STAX_BASE_URL to a non-production test deployment; failed logins write rate-limit/audit metadata.',
    );

    // 1. Submit invalid credentials at /login.
    await page.goto(`${baseUrl}/login`);
    await page.getByRole('textbox', { name: 'name@company.com' }).fill('invalid-user@example.invalid');
    await page.getByRole('textbox', { name: '••••••••' }).fill('not-a-valid-password');
    await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();

    await expect(page.getByText('อีเมลหรือรหัสผ่านไม่ถูกต้อง')).toBeVisible();
    await expect(page).toHaveURL(/\/login(?:\?.*)?$/);
    await expect(
      page.getByRole('heading', { name: 'สรุปสถานะการเงินรวม (Financial Position)' }),
    ).toHaveCount(0);
  });

  test('holding opens stock detail', async ({ page }) => {
    test.skip(
      !isNonProductionTargetConfigured(),
      'Set STAX_BASE_URL to a non-production test deployment; production authentication writes rate-limit/audit metadata.',
    );
    test.skip(!testEmail || !testPassword, 'Set STAX_TEST_EMAIL and STAX_TEST_PASSWORD to run this read-only scenario.');

    // 1. Select a visible ticker from dashboard holdings, inspect details, then return.
    await page.goto(`${baseUrl}/login`);
    await page.getByRole('textbox', { name: 'name@company.com' }).fill(testEmail!);
    await page.getByRole('textbox', { name: '••••••••' }).fill(testPassword!);
    await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
    await expect(page).toHaveURL(/\/dashboard(?:\?.*)?$/);

    const holdings = page.getByRole('heading', { name: 'การถือครองหุ้น' }).locator('xpath=../..');
    await expect(holdings).toBeVisible();
    const firstHoldingRow = holdings.getByRole('row').nth(1);
    const tickerButton = firstHoldingRow.getByRole('button');
    await expect(tickerButton).toBeVisible();
    const ticker = (await tickerButton.locator('p').first().innerText()).trim();
    await tickerButton.click();

    await expect(page.getByText('รายละเอียดหุ้นรายตัว', { exact: true })).toBeVisible();
    await expect(page.getByText(ticker, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'การถือครอง', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'ราคาและมูลค่าตลาด' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'กำไร/ขาดทุนที่รับรู้แล้ว' })).toBeVisible();

    await expect(
      page.getByRole('heading', { name: `ธุรกรรมทั้งหมดของ ${ticker}` }),
    ).toBeVisible();
    const transactionTable = page.getByRole('table');
    await expect(transactionTable).toBeVisible();
    await expect(transactionTable.getByRole('row').nth(1)).toBeVisible();

    await page.getByRole('button', { name: 'กลับหน้าหลัก' }).click();
    await expect(
      page.getByRole('heading', { name: 'สรุปสถานะการเงินรวม (Financial Position)' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'การถือครองหุ้น' })).toBeVisible();
  });
});
