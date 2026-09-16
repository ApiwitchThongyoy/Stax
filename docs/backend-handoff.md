# STAX backend handoff — September 18, 2026

Runtime: `npm run build` then `npm start`, from the repository root. Tested on
Windows with Node **24.18.0** and disposable PostgreSQL **17**. Install Node 24,
npm, and PostgreSQL 17 (Docker is suitable). CI currently uses Node 22 and PG17.
Use `npm ci` to install the locked dependencies.

## Local configuration

Copy `.env.example` to `.env` and configure it locally; never commit `.env`.

| Variable | Requirement |
| --- | --- |
| `DATABASE_URL` | Required: local PostgreSQL connection |
| `JWT_SECRET` | Required: generate a strong private signing secret |
| `CRON_SECRET` | Required for authorized cron tests/scheduling; generate a private secret |
| `STORAGE_MODE` | Use `local` for this handoff |
| `PORT` | Optional; Node defaults to 3000 |
| `TEST_DATABASE_URL` | Tests only: fresh disposable local database, name ending `_test` |
| `TEST_BASE_URL` | HTTP smoke only: running localhost server URL |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | Optional live AI analysis; leave blank for deterministic checks |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_STORAGE_BUCKET` | Only for optional private Supabase storage; leave blank for this handoff |

Local PDFs live in `storage/statements` under the working directory; it must be
writable and retained with the local database. The built Node server and Drizzle
need environment variables loaded explicitly; copying `.env` alone is insufficient.
PowerShell: `$env:NODE_OPTIONS='--env-file=.env'`. Bash:
`export NODE_OPTIONS='--env-file=.env'`. Do not set `USE_TEST_DATABASE` or
`NODE_ENV=test` on the handoff server.

## Reproduce the release checks (PowerShell)

Provision an **empty disposable PostgreSQL 17 database** first. Set both URL
variables in `.env` to that same local `_test` database. Leave Gemini/Supabase
configuration blank and use local storage. Never use a production database.
`test:w2` seeds its own users; do not seed manually or run the HTTP smoke first.

```powershell
npm ci
$env:NODE_OPTIONS='--env-file=.env --import=./scripts/test-offline-network.mjs'
node scripts/ci-verify-migrations.mjs --fresh
npm run db:migrate
node scripts/ci-verify-migrations.mjs --verify
npx drizzle-kit check
npm run typecheck
npm test
npm run test:w2
npm run build
git diff --check
$env:NODE_ENV='production'
npm start
```

Stop on any failed command. If PowerShell blocks npm's `.ps1` shim, use `npm.cmd`
and `npx.cmd`. In a second terminal, with the same `.env`:

```powershell
$env:NODE_OPTIONS='--env-file=.env --import=./scripts/test-offline-network.mjs'
$env:TEST_BASE_URL='http://127.0.0.1:3000'
node scripts/test-release-node.mjs
```

Adjust the port to match `PORT`. The smoke test verifies that the server uses the
same test database, seeds a cached stock quote, and cleans its own records/PDFs.
The offline preload blocks unmocked external fetches; provider tests use mocks.
`test:w2` deliberately retains its three seed users/sample data. After testing,
stop the server and remove only the disposable database/container and PDFs created
by the test run. Preserve any pre-existing storage files. For a repeat **clean**
integration run, provision another empty database.

For ordinary local manual testing, load only `--env-file=.env`, then run
`npm run db:migrate`, `npm run build`, and `npm start`. External stock/FX calls
can then occur; live Gemini requires an explicitly configured test key.

## Tester checklist and verified behavior

- Register USER, normalized login, session, heartbeat, bad credentials, rate limits,
  and suspended account rejection. No backend logout/revocation route exists;
  logout removes the client token, while suspension is enforced from the database.
- Supported flow: `POST /api/v1/statements/preview` then
  `POST /api/v1/statements/upload`, both multipart `file`. Preview is read-only;
  upload performs deterministic import. Gemini is optional analysis, not persistence
  authority. Valid but unsupported text PDFs may be archived with zero imported rows.
- Reject invalid extension/MIME/header, files above 20 MB, corrupt/textless PDFs.
  List documents, inspect transactions, download original bytes, duplicate, delete,
  and rebuild after derived-row deletion. Extraction/storage-write failures leave
  no document rows. The final check fixed extraction errors leaving archived files.
- Capital transactions, accounts, balanced journal create/reversal, account ledger,
  ledger/cash summaries, cost basis, symbol portfolio, corporate actions, and notes.
- Trial balance, income statement, balance sheet: known A=100/B=900 fixtures remain
  separate. USER cannot access another user's resources or admin APIs; DB ADMIN can.
- Stock cache, stale fallback, normalization, invalid symbols, timeouts, malformed
  payloads, 404/429/500/503, exchange dates, incomplete bars, concurrent upserts,
  repeated refresh, partial success, and credential-safe cron/ADMIN authorization.
- HTTP smoke additionally covers root, settings, notifications, journal reversal,
  PDF persistence/download/delete and simulated local storage-write failure.

Verification: 25/25 migrations; `test:w2` **487 PASS / 0 FAIL**; built Node HTTP
smoke **51 PASS / 0 FAIL**. All 20 `npm test` suites, typecheck, build, Drizzle
check and whitespace check passed. No production services were used.

## Non-blocking follow-ups

- Node does not schedule jobs itself. Configure an external daily GET to
  `/api/v1/stock-prices/refresh` at 22:30 UTC, with
  `Authorization: Bearer <CRON_SECRET>`. Missing/wrong secrets return 401;
  manual POST requires ADMIN. `vercel.json` only configures Vercel scheduling.
- Vercel adapter/deployment compatibility is outside this Node handoff.
- Physical file deletion after DB commit is best-effort: storage deletion failure
  can leave an orphan file for manual cleanup; it does not resurrect financial rows.
- Live Gemini/Supabase/provider connectivity was not tested. Optional live AI uses
  a tester-supplied key; deterministic imports and release tests require none.
- Previously documented same-user concurrent reversal and legacy data repair work
  remain follow-ups; sequential reversal and cross-user isolation pass.
- Existing build deprecation/chunk-size warnings are non-blocking.

## Version

`package.json` **version 1.0.0** is authoritative; `package-lock.json` mirrors it.
Increment PATCH for fixes, MINOR for backward-compatible features, MAJOR for
breaking changes. Use `npm version patch|minor|major --no-git-tag-version` (choose
one). No version endpoint, tags, commits, or releases are needed for this handoff.
