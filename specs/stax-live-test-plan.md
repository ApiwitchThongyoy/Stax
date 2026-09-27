# STAX Live Application Test Plan

## Application Overview

Read-only exploratory plan for the live STAX financial ledger app at https://stax-delta.vercel.app/login. The authenticated account contained 15 current holdings, 43 trading-journal rows, 71 journal entries (63 posted, 6 reference-only, 2 without debit/credit), 3 archived Statements, and THB/USD ledger data. Keep credentials in environment variables. Use the supplied live test account only for read-only checks; run any writes only against a disposable test account/database with cleanup.

## Test Scenarios

### 1. Authentication and dashboard

**Seed:** `tests/seed.spec.ts`

#### 1.1. valid login and dashboard shell

**File:** `tests/auth-dashboard.spec.ts`

**Steps:**
  1. Open /login and sign in using STAX_TEST_EMAIL and STAX_TEST_PASSWORD.
    - expect: Navigation reaches /dashboard and displays the signed-in user.
    - expect: Primary sidebar sections for home, trading journal, journal, general ledger, upload, archive, and cash flow are available.
  2. Wait for dashboard widgets and toggle financial trend comparison.
    - expect: Portfolio, financial position, holdings, and cash summary widgets load.
    - expect: The chart series toggle works without changing the financial totals.

#### 1.2. invalid login remains unauthenticated

**File:** `tests/auth-dashboard.spec.ts`

**Steps:**
  1. Submit invalid credentials at /login.
    - expect: An authentication error is displayed; the page remains at login and protected content is absent.

#### 1.3. holding opens stock detail

**File:** `tests/auth-dashboard.spec.ts`

**Steps:**
  1. Select a visible ticker from dashboard holdings, inspect details, then return.
    - expect: Ticker-specific holding, quote, transaction rows, and server totals are displayed.
    - expect: Missing quote data is represented honestly; returning restores the dashboard.

### 2. Trading journal and journal

**Seed:** `tests/seed.spec.ts`

#### 2.1. trading journal filters and pagination

**File:** `tests/trading-journal.spec.ts`

**Steps:**
  1. Apply a ticker, side, and date filter; clear filters; test next/previous page when results exceed 20.
    - expect: Rows, result count, and page range match all active filters.
    - expect: Clearing filters restores results; filter changes reset to page one; sold-out symbols remain in history but not current-holdings cards.

#### 2.2. trading note is read-only when viewed

**File:** `tests/trading-journal.spec.ts`

**Steps:**
  1. Open an existing transaction note without entering edit mode.
    - expect: The note matches the selected row and no note is modified.

#### 2.3. journal search and status classification

**File:** `tests/journal-ledger.spec.ts`

**Steps:**
  1. Filter journal entries by date, source, and status; search by description/ticker/account/memo/entry number; expand posted, reference-only, and unposted entries.
    - expect: Search and filter results/counts update and clear correctly.
    - expect: Posted entries show balanced debit/credit detail; reference-only rows are distinguished from entries lacking debit/credit; explanations open without mutation.

### 3. General ledger and reports

**Seed:** `tests/seed.spec.ts`

#### 3.1. category and account drill-down

**File:** `tests/journal-ledger.spec.ts`

**Steps:**
  1. Search within account categories, open a populated account, then inspect a linked transaction and return.
    - expect: Category search narrows/clears correctly.
    - expect: Account opening, movements, and closing values are shown; transaction detail matches the source row and prev/next respects bounds.

#### 3.2. reports, as-of dates, and invalid ranges

**File:** `tests/journal-ledger.spec.ts`

**Steps:**
  1. Inspect Trial Balance, Income Statement, Balance Sheet, and Monthly Closing with default and narrowed date ranges; change and apply the Balance Sheet as-of date.
    - expect: Reports show native currency and THB values where available, with no cross-currency addition.
    - expect: Trial Balance balance status is coherent; Balance Sheet excludes entries after the as-of date; monthly closing is chronological with balance/continuity status.
  2. Try an impossible date and reversed range where date fields permit input.
    - expect: Invalid/reversed input is rejected clearly or leaves the last valid result visible; it is not presented as a successful refreshed report.

### 4. Statements, cash flow, and settings

**Seed:** `tests/seed.spec.ts`

#### 4.1. archive search and transaction detail

**File:** `tests/statements-cash-settings.spec.ts`

**Steps:**
  1. Search a known archived filename, clear search, expand its transaction list, and download an owned PDF.
    - expect: Archive grouping and filename/date/size/count metadata render correctly.
    - expect: Expanded transaction count agrees with rows and summary; download yields non-empty PDF with safe filename. Do not delete.

#### 4.2. preview cancellation and validation

**File:** `tests/statements-cash-settings.spec.ts`

**Steps:**
  1. With a disposable PDF fixture, preview a fresh or duplicate Statement and cancel before confirmation; test invalid type/oversize fixtures in isolated environment.
    - expect: Preview includes row details and server summary; duplicate/unsupported state is clear.
    - expect: Cancel leaves document, capital transaction, and journal counts unchanged; invalid type/size does not import. Commit-path coverage is restricted to isolated data and verifies no duplicate on repeat.

#### 4.3. cash modes and exchange separation

**File:** `tests/statements-cash-settings.spec.ts`

**Steps:**
  1. Switch cash view through all-time, monthly, as-of, and exchange modes; inspect the chronological rows and exchange direction panel.
    - expect: Each mode applies the intended period/cutoff and displays only its relevant sections.
    - expect: Cash deposits/withdrawals are separate from BUY/SELL and currency conversions; exchange totals/rates/directions do not count as income or expenses.

#### 4.4. notifications and settings inspection

**File:** `tests/statements-cash-settings.spec.ts`

**Steps:**
  1. Open notification panel and settings; inspect messages, preference states, help affordance, and sign-out without activating state-changing controls.
    - expect: Notifications and preference states are readable and remain unchanged.
    - expect: Help behavior is documented or flagged for clarification; sign-out is not triggered.
