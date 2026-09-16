# Authorization and user isolation audit

Branch: `backend/user-isolation-audit`. Scope: current local tree, backend only.
The four inherited changed files were preserved and extended. No migration,
frontend, deployment, commit, or push is part of this task.

## Route ownership matrix

Authoritative inventory: `app/routes.ts`. All paths below have prefix `/api/v1/`.
Methods are supported operations; other methods either return 405 or have no
registered handler. Authentication means `verifyAuth` resolves current status,
email, and role from the database after verifying the token. A JWT role alone
does not authorize admin access.

Tests: **live** = real route handlers against disposable PostgreSQL; **existing**
= covered by the existing full regression suite; **source** = inspected code and
static guards. IDOR risk describes the boundary tested, not an unfixed exploit.

| Route | Method | Class | Auth | Resource / ownership and user filter | IDOR risk / test status |
|---|---|---|---|---|---|
| auth/login | POST | AUTH_SELF | Credentials | Normalized email + password, returns only matched user | Identity; existing |
| auth/register | POST | AUTH_SELF | Public | Server UUID and USER role; no caller-selected owner | Identity; existing |
| auth/session | GET | AUTH_SELF | JWT + DB | Current authenticated User | Self; existing/source |
| auth/heartbeat | POST | AUTH_SELF | JWT + DB | POST updates User.id = auth.userId; current GET loader delegates to action and returns 405 | Self; existing/source |
| settings | GET, PATCH | AUTH_SELF | JWT + DB | user_settings.userId = auth.userId; mutation and reread include owner | Mutation; live/source |
| notifications | GET, PATCH | USER_SCOPED | JWT + DB | List, unread count, read-all filter userId | Aggregate/mutation; live/source |
| notifications/:id/read | PATCH | USER_SCOPED | JWT + DB | id AND userId in UPDATE RETURNING | Foreign ID; live 404 |
| capital-ledgers | GET, POST | USER_SCOPED | JWT + DB | Journal read userId; insert owner from auth | List/write; live |
| capital-ledgers/:id | GET, PUT, PATCH, DELETE | USER_SCOPED | JWT + DB | Journal read by sourceTransactionId + userId; capital mutation by transactionId + userId | Foreign ID; live 404 + DB unchanged |
| cash-summary | GET | USER_SCOPED | JWT + DB | listCashSummaryRows/listFxConversionRows filter journal userId | Aggregate; live 100/900 |
| corporate-actions | GET, POST | USER_SCOPED | JWT + DB | Service list/insert uses auth.userId; symbols are not foreign user IDs | List/write; live/existing |
| corporate-actions/:id | DELETE | USER_SCOPED | JWT + DB | id AND userId in service SELECT and DELETE | Foreign ID; live 404 + DB unchanged |
| accounts | GET, POST | USER_SCOPED | JWT + DB | Account list/seed/insert uses auth.userId | List/write; live/existing |
| journal | GET, POST | USER_SCOPED | JWT + DB | Headers/lines/account lookup scoped to owner; same-owner joins | Forged account; live 422 + no write |
| journal/:id/reverse | POST | USER_SCOPED | JWT + DB | Header id + userId; lines entryId + userId; status UPDATE also scoped | Foreign ID; live 404 + no reversal |
| ledger/accounts/:accountId | GET | USER_SCOPED | JWT + DB | Account id + userId; lines scoped to user and account, same-owner joins | Foreign ID; live 404 |
| ledger/summary | GET | USER_SCOPED | JWT + DB | getBalanceSheet: owner accounts and lines | Aggregate; live |
| cost-basis | GET | USER_SCOPED | JWT + DB | cost_basis_state.userId | Aggregate; live 100/900 |
| portfolio/:symbol | GET | USER_SCOPED | JWT + DB | Journal symbol + userId; holding symbol + userId; quote intentionally global | Aggregate; live 100/900 |
| trading-journal | GET | USER_SCOPED | JWT + DB | User journal replay and holdings; quotes intentionally global | List/aggregate; live 100/900 |
| trading-journal/:transactionId/note | PUT, DELETE | USER_SCOPED | JWT + DB | sourceTransactionId AND userId in UPDATE | Annotation; live 404 + DB unchanged |
| reports/trial-balance | GET | USER_SCOPED | JWT + DB | User accounts and lines, same-owner joins | Aggregate; live |
| reports/income-statement | GET | USER_SCOPED | JWT + DB | User accounts and lines, same-owner joins | Aggregate; live |
| reports/balance-sheet | GET | USER_SCOPED | JWT + DB | User accounts/openings and lines, same-owner joins | Aggregate; live |
| statements/upload | POST | USER_SCOPED | JWT + DB | Server owner/document ID; hash lookup (userId, hash); own cost basis/import/rebuild | Duplicate/link/storage; live |
| statements/preview | POST | USER_SCOPED | JWT + DB | Hash and basis lookup use auth.userId; no write | Duplicate metadata; live |
| documents | GET | USER_SCOPED | JWT + DB | Documents owner filter; journal count joins include owner; no file_path DTO | List/count; live |
| documents/:id | DELETE | USER_SCOPED | JWT + DB | id + userId; atomic owner-filtered capital/document deletes; storage key from own row | Foreign ID; live 404 + DB/PDF unchanged |
| documents/:id/download | GET | USER_SCOPED | JWT + DB | id + userId before opening storage; path containment | Foreign ID; live 404; existing own download |
| documents/:id/transactions | GET | USER_SCOPED | JWT + DB | Own document lookup, then journal documentId + userId | Foreign ID; live 404 + owner positive |
| stock-prices | GET | GLOBAL_READ | JWT + DB | Public reference quotes, no user-owned data | Intentionally shared; existing/source |
| stock-prices/refresh | GET, POST | CRON_OR_ADMIN | Secret / DB ADMIN | GET requires cron secret; POST accepts cron secret or DB ADMIN | Privileged write; existing |
| exchange-rates | GET | GLOBAL_READ | JWT + DB | Shared historical reference/cache; no user-owned data | Intentionally shared; existing/source |
| exchange-rates/status | GET | ADMIN_ONLY | DB ADMIN | Provider configuration status, no secret values | Role boundary; live |
| admin/users | GET | ADMIN_ONLY | DB ADMIN | Deliberate cross-user administrative view | USER/stale ADMIN denied; live |
| admin/users/:id | PATCH | ADMIN_ONLY | DB ADMIN | Deliberate target User ID; only USER targets allowed | USER/stale ADMIN denied; live + target unchanged |
| admin/stats | GET | ADMIN_ONLY | DB ADMIN | Deliberate global aggregates | USER/stale ADMIN denied; live |
| admin/audit-logs | GET | ADMIN_ONLY | DB ADMIN | Deliberate global audit view | USER/stale ADMIN denied; live |
| admin/documents | GET | ADMIN_ONLY | DB ADMIN | Deliberate global document metadata view | USER/stale ADMIN denied; live |

`GET documents/:id` and `GET corporate-actions/:id` do not implement resource
reads: their loaders return 405. Both are explicitly tested as N/A. There is no
separate import/rebuild-by-document-ID endpoint: rebuild occurs through upload
after the per-user hash lookup.

## Findings and exact changes

No exploitable cross-user API read/write was reproduced in the reviewed routes.
The following service-level trust gaps and defense-in-depth omissions were found:

1. Inherited changes already made both import paths use the service `userId`
   instead of `row.userId`. Live tests prove a row carrying B's ID writes only
   under A. The changes are retained.
2. Import and journal services accepted source document/transaction IDs without
   checking ownership. Current HTTP routes generate these links themselves or
   ignore client link fields, so this was a latent service-level relationship
   gap, not a demonstrated remote IDOR. New `resource-ownership.ts` validates
   each non-null link by ID AND owner within the write transaction. SHARE row
   locks prevent deletion/ownership change between check and insertion. Both
   import paths and journal/manual-cash/backfill creation call it. Errors contain
   no resource identifiers. Foreign/missing references fail without partial writes.
3. Inherited ledger mutation filters were retained; settings UPDATE and reread
   now also include userId. Ledger post-insert rereads and line-count queries
   are owner-scoped. This closes reliance on ownership prechecks alone. There is
   no exposed ownership-transfer API; this is hardening against future changes.
4. Aggregate joins now require journal header, line, and account owners to
   agree. A live test deliberately creates inconsistent lines using direct SQL;
   neither B's header nor account appears in A's journal/reports.
5. Foreign/missing account ledger now returns 404 rather than empty 200.
   Foreign/missing journal reversal now returns 404 rather than 400. Both pairs
   have byte-equivalent JSON responses and never mutate B.
6. Changed runtime files use the existing safe logging helper instead of raw
   exceptions. No broad logging refactor was performed.

No schema change or composite foreign key migration was required.

## Live proof

New tests run through `scripts/run-tests.mts`, with implementation separated into
`scripts/user-isolation-db.mts`. They use two fresh users, real JWTs, real route
handlers and real PostgreSQL queries. They verify all 22 requested categories
(the two nonexistent GET operations are N/A), including actual database state
after denied destructive requests, and identical foreign/missing responses.

| Measurement | A | B |
|---|---:|---:|
| Cash in / net cash (THB) | 100 | 900 |
| Income (THB) | 100 | 900 |
| Ledger/balance-sheet assets and trial-balance debit (cash + income) | 200 | 1800 |
| ISOX holding quantity | 100 | 900 |
| Portfolio and trading-journal trade count | 1 | 1 |

All aggregate calls also send the other user's ID as a query parameter. It does
not affect the authoritative identity. A's responses never become combined
totals of 1000 or 2000.

Documents are deduplicated per `(user_id, content_hash)`, not globally. A preview
of B's PDF does not disclose B's document ID. A upload creates a separate A
document/storage key; duplicate/rebuild resolves only A's document. A's deletion
removes A's PDF. All B database snapshots and PDF bytes remain unchanged.
Storage uses the local driver only; no live Supabase storage is used. Tests
remove their fresh user fixtures and verify every fixture PDF is gone.

Normal USER tokens and validly signed tokens claiming ADMIN for a DB USER are
denied at every administrative boundary. DB ADMIN remains functional.

## Verification and follow-ups

Exact changed files, including inherited uncommitted work:

- `AGENTS.md` — current status.
- `app/lib/ledger-service.ts` — reference validation, owner predicates/joins, safe logs.
- `app/lib/statement-pipeline.ts` — authoritative owner, document validation, safe log.
- `app/lib/resource-ownership.ts` — new transactional ownership helper.
- `app/routes/api/settings.ts` — owner-scoped mutation/reread and safe logs.
- `app/routes/api/ledger.$accountId.ts` — safe missing/foreign 404 and safe log.
- `app/routes/api/journal.$id.reverse.ts` — safe missing/foreign 404 and safe log.
- `package.json` — inherited static-test registration retained.
- `scripts/test-user-isolation.mts` — inherited guards strengthened/extended.
- `scripts/user-isolation-db.mts` — new live two-user regression module.
- `scripts/run-tests.mts` — invokes the new regression module.
- `docs/user-isolation-audit.md` — this matrix, evidence and report.

Verified: `npm test` passes all 20 suites, including 260 source isolation guards;
`test:w2` reports **461 PASS / 0 FAIL** (105 new isolation assertions).
`drizzle-kit check`, typecheck, build, and `git diff --check` pass.
Fresh PostgreSQL 17 migration and `ci-verify-migrations --verify` pass 25/25.
The task container `stax-isolation-audit-test` (localhost:55442) was removed by
its verified full ID after checking its task label. All new isolation PDFs were
removed by the tests. Four PDFs left by existing suite blocks were matched to
the disposable seed user's UUID and removed explicitly; older storage remains.
Migration count remains 25 (through 0025; historical 0018 absent).

Boundaries outside this proof: direct privileged SQL can still create mismatched
owners because the schema lacks composite ownership FKs. Legacy dangling links
now fail validation when reused by a service write; assess/repair such links in
a separate data-maintenance task if present. Same-user concurrent reversal can
still race (create reversal and mark original are separate operations); this
does not permit cross-user access and was not expanded into accounting redesign.
Raw-error logging in untouched files remains a separate hardening task. Tests
invoke route handlers directly, not a deployed reverse proxy/storage policy.
