# STAX Project Instructions

## Development Focus

- Current focus is Backend and Database development.
- Do not work ahead of my instructions.
- Only implement tasks that I explicitly request.
- After completing the requested task, stop and wait for my next instruction.

## Existing Frontend

- Preserve the existing Frontend design.
- Do not redesign the UI.
- Do not significantly change existing pages, layouts, components, or styles.
- If Backend integration requires Frontend changes, make only the minimum necessary changes.
- Do not rewrite working Frontend code without a clear reason.

## Existing Project

Before implementing a task:

1. Inspect the relevant existing files.
2. Check the existing project structure and technology stack.
3. Reuse existing libraries and architecture whenever possible.
4. Do not replace frameworks/libraries unless explicitly requested.
5. Do not modify unrelated files.

## Backend and Database

- Implement only the Backend/Database feature currently requested.
- Inspect the existing database schema before changing it.
- Do not create unrelated tables, endpoints, services, or features.
- Never store passwords in plain text.
- Never expose secrets or environment variables.

## Current Known Database Requirement

users:

- ID: UUID
- Email: Unique
- Password_Hash
- Role

## Task Workflow

For each task:

1. Read AGENTS.md.
2. Inspect relevant existing project files.
3. Determine the smallest changes required.
4. Implement only the requested scope.
5. Check for errors.
6. Briefly report which files were changed and what was done.
7. Update Current Status when appropriate.
8. Stop and wait for my next instruction.

## Current Status

Project:
STAX

Current focus:
Backend and Database

Known requirement:
users table with UUID ID, unique Email, Password_Hash, and Role.

Completed:
- Existing project cloned from the current shared repository.
- React Router development skill exists under .agents/skills/react-router/.
- Prisma 7 configured with SQLite (prisma.config.ts, prisma/schema.prisma, .env).
- users table created via migration create_users (prisma/migrations/20260807130407_create_users).
- Prisma Client generated under prisma/generated/prisma.
- documents table created via migration create_documents (prisma/migrations/20260808105847_create_documents). Stores metadata + file_path for uploaded Statement PDFs (no binary in DB). FK documents.user_id -> User.id with index on user_id.
- Server-authoritative frontend wiring done (Drizzle + Postgres/Supabase; Prisma is legacy, not used): added user-scoped `GET /api/v1/documents` (app/routes/api/documents.ts) returning safe metadata; shared `app/lib/server-api.ts` (fetchCapitalLedger / fetchUserDocuments / capitalRowToTransaction / capitalLedgerToTransactions — identity=authoritative transactionId, no fabricated P&L). Dashboard, FxAiPage, Calendar, Statement Archive, and StoredDocumentsList now render from server (ledger + documents API) instead of session-import React state / IndexedDB. Tests: scripts/test-server-api.mts (pure mapping + wiring) added to `npm test`; W2-9 documents user-scoping section added to scripts/run-tests.mts. All tests + typecheck + build pass. Changes NOT committed.

Next:
Wait for user instruction.
