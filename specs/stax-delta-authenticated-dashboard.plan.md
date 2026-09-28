# STAX Delta Authenticated Statement Import

## Application Overview

End-to-end test of the main STAX Delta workflow on https://stax-delta.vercel.app/: authenticate with test credentials from the environment, import the designated February 2026 statement PDF, verify the resulting financial views and currency exchanges, and check data consistency after navigation. This test intentionally writes financial data to the deployed test account. Precondition: the test account has not already imported this exact PDF, or it has been reset to a known baseline. Do not silently accept a duplicate as a successful fresh import.

## Test Scenarios

### 1. Authenticated statement import and financial data consistency

**Seed:** `tests/seed.spec.ts`

#### 1.1. Import the February 2026 statement and verify persisted financial data

**File:** `tests/stax-delta-authenticated-dashboard.spec.ts`

**Steps:**
  1. Open https://stax-delta.vercel.app/ and inspect the public login page.
    - expect: The page title is STAX.
    - expect: The email textbox, password textbox, and login button are visible.
  2. Read the test email and password from the configured environment, enter them, and submit the login form.
    - expect: Login succeeds and navigates to /dashboard.
    - expect: The authenticated identity shown in the sidebar matches the test email/account.
  3. Record the initial dashboard state before importing: the four THB financial-position metrics and relevant empty states.
    - expect: The dashboard greeting and Financial Position summary are visible.
    - expect: Capture the initial values of net financial position, total cash, investment value, and realized P&L for comparison after import.
    - expect: For the observed fresh account, the initial values are ฿0.00 and holdings/cash movement sections show their empty states.
  4. Navigate to อัปโหลด Statement and select E:\STAX\Datatest\Datatest\2026-02.PDF from the file chooser.
    - expect: The selected filename is 2026-02.PDF.
    - expect: The app accepts the PDF and opens the import review/preview screen without an unsupported-file or extraction error.
    - expect: The preview reports at least one importable transaction and shows its server-provided row counts and transaction details.
    - expect: The preview identifies this as a fresh import; if it reports an existing duplicate, stop because the baseline precondition is not met.
  5. Review the preview, then confirm import using the button labeled with the number of importable rows (OK/นำเข้า).
    - expect: The import completes and shows its result screen.
    - expect: The result reports saved > 0 and a fresh-import outcome, with no upload, parsing, or posting failure.
    - expect: The result's saved and transaction-type counts agree with the preview/server response.
  6. Return to หน้าหลัก and wait for the dashboard data to finish loading.
    - expect: All four THB metrics display loaded currency values and are compared with their recorded initial values; at least one applicable metric reflects the imported data rather than the prior all-zero state.
    - expect: Imported statement/transaction data is visible in the dashboard or in the linked statement/transaction view reachable from it.
    - expect: Holdings are populated when the preview contained BUY transactions; cash movements are populated when the preview contained applicable deposit/withdrawal rows.
    - expect: No loading placeholder or empty state remains for a section whose corresponding transaction type was imported. Empty states are acceptable only for transaction types absent from the preview.
  7. Open เงินเข้า/ออก, select แลกเปลี่ยนสกุลเงิน, and compare the displayed exchange records with the exchange rows reported by the statement preview/import result.
    - expect: The heading and table headers are visible: วันที่, ทิศทาง, จำนวนเงินต้นทาง, จำนวนเงินปลายทาง, and อัตรา.
    - expect: When the imported statement contains exchange rows, the table shows those rows with matching source/destination currencies, amounts, and rates; otherwise, the honest no-exchange empty state is shown and agrees with the preview.
    - expect: Exchange transfers are not counted or labeled as income/expense.
  8. Navigate back to หน้าหลัก, then return once more to เงินเข้า/ออก → แลกเปลี่ยนสกุลเงิน.
    - expect: Dashboard financial totals and populated/empty states remain consistent with the post-import values recorded earlier.
    - expect: The exchange rows/count and their displayed details remain unchanged after navigation.
    - expect: The file is not duplicated and no additional import is triggered by navigation.
