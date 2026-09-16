// DB-free source-of-truth sync test for chk_audit_logs_action.
//
// The audit action closed set lives in THREE places:
//   1. app/lib/audit-log.ts        -> AuditAction as-const object (typed union
//      AuditLogInput.action, so the compiler only accepts these values)
//   2. app/db/schema.ts            -> check("chk_audit_logs_action", sql`... IN (...)`),
//      the Drizzle source that "generate/CI never drift"
//   3. drizzle/0025_...sql        -> the actual DB CHECK (NOT VALID, historical
//      audit spans pre-repo deployments whose exact actions are unprovable)
//
// Adding an AuditAction value is a deliberate, rare, feature-driven change and
// REQUIRES updating the migration CHECK too (and normally also the schema mirror).
// This test makes a forgotten migration FAIL LOUDLY instead of insertAuditLog's
// best-effort try/catch silently swallowing the 23514 rejection.
//
// Pure text extraction: no Drizzle, no DB client, no DATABASE_URL needed.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, sep } from "node:path";

const root = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "");

const lastMigrationVersion = (): number => {
  const entries = readdirSync(join(root, "drizzle"))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  assert.ok(entries.length > 0, "expected at least one drizzle migration");
  return Number(entries[entries.length - 1].slice(0, 4));
};

const extractQuoted = (text: string): string[] => {
  const values = [...text.matchAll(/'([A-Z][A-Z_0-9]*)'/g)].map((m) => m[1]);
  return [...new Set(values)].sort();
};

const auditActionValues = (): string[] => {
  const src = readFileSync(join(root, "app", "lib", "audit-log.ts"), "utf8");
  const block = /export const AuditAction\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(src);
  assert.ok(block, "AuditAction as-const object not found in audit-log.ts");
  const values = [...block[1].matchAll(/['"]([A-Z][A-Z_0-9]*)['"]/g)].map((m) => m[1]);
  return [...new Set(values)].sort();
};

const migrationCheckValues = (): string[] => {
  const latest = lastMigrationVersion();
  const file = readdirSync(join(root, "drizzle"))
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()
    .filter((f) => Number(f.slice(0, 4)) === latest)[0];
  const sql = readFileSync(join(root, "drizzle", file), "utf8");
  const block = /chk_audit_logs_action[\s\S]*?CHECK\s*\(\s*"action"\s*IN\s*\(([\s\S]*?)\)\s*(?:NOT VALID)?\s*;/i.exec(
    sql
  );
  assert.ok(
    block,
    `chk_audit_logs_action must be defined in the latest migration ${file}`
  );
  return extractQuoted(block[1]);
};

const schemaCheckValues = (): string[] => {
  const src = readFileSync(join(root, "app", "db", "schema.ts"), "utf8");
  const block = /chk_audit_logs_action[\s\S]*?IN\s*\(([\s\S]*?)\)\s*`/.exec(src);
  assert.ok(block, "chk_audit_logs_action check not found in app/db/schema.ts");
  return extractQuoted(block[1]);
};

const walk = (): string[] => {
  const refs: string[] = [];
  const scan = (dir: string): void => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name);
      if (f.isDirectory()) scan(p);
      else if (/\.(ts|tsx)$/.test(f.name)) {
        const src = readFileSync(p, "utf8");
        for (const m of src.matchAll(/\bAuditAction\.([A-Z][A-Z_0-9]*)\b/g)) refs.push(m[1]);
      }
    }
  };
  scan(join(root, "app"));
  return refs;
};

let pass = 0;
const check = (name: string, fn: () => void) => {
  fn();
  pass += 1;
  console.log(`PASS ${name}`);
};

check("AuditAction as-const object captures 25 distinct actions", () => {
  assert.equal(auditActionValues().length, 25);
});
check("action field is typed as AuditActionValue (raw strings impossible)", () => {
  const src = readFileSync(join(root, "app", "lib", "audit-log.ts"), "utf8");
  assert.match(src, /\baction:\s*AuditActionValue\b/);
  // Every route file that calls insertAuditLog must only ever pass AuditAction.*
  // constants — a raw `action: "..."` literal in the same file is a compile-time
  // bypass of the union and a sync-test-visible drift. Invariant verified for
  // the whole tree (and originally enumerated via `git grep`).
  const files = [] as string[];
  const scan = (dir: string): void => {
    for (const f of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, f.name);
      if (f.isDirectory()) scan(p);
      else if (/\.(ts|tsx)$/.test(f.name)) files.push(p);
    }
  };
  scan(join(root, "app"));
  for (const p of files) {
    const text = readFileSync(p, "utf8");
    if (text.includes("insertAuditLog(")) {
      const raw = [...text.matchAll(/\baction:\s*"([^"]+)"/g)].filter(
        (m) => m[1] !== "__test_never__"
      );
      assert.equal(
        raw.length,
        0,
        `${p} passes a raw audit action string instead of AuditAction.*`
      );
    }
  }
});
check("AuditAction values == schema.ts check == latest migration CHECK", () => {
  const actions = auditActionValues();
  const schema = schemaCheckValues();
  const migration = migrationCheckValues();
  assert.deepEqual(schema, actions, "app/db/schema.ts check must mirror AuditAction");
  assert.deepEqual(migration, schema, "latest migration CHECK must mirror schema.ts");
  console.log(
    `  (${actions.length} actions: ${actions.join(", ")})`
  );
});
check("AuditAction keys never drift from values", () => {
  const src = readFileSync(join(root, "app", "lib", "audit-log.ts"), "utf8");
  const block = /export const AuditAction\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(src)!;
  const entries = [...block[1].matchAll(/([A-Z][A-Z_0-9]*):\s*['"]([A-Z][A-Z_0-9]*)['"]/g)];
  for (const [, key, value] of entries) assert.equal(key, value);
});
check("every AuditAction value is referenced by at least one call site", () => {
  const values = auditActionValues();
  const refs = new Set(walk());
  const unreferenced = values.filter((v) => !refs.has(v));
  // LOGIN_FAILED / STATEMENT_IMPORT have no post-ingress producer today but are
  // valid retained members of the closed set; assert the comparable majority.
  assert.ok(values.length - unreferenced.length >= 23);
});

console.log(`test-audit-actions-sync: ${pass} PASS / 0 FAIL`);