import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import type postgres from "postgres";
import { parseStatementIdentity, supportedStatementIdentity } from "../app/lib/statement-identity";

/** Invoked exclusively by the TEST_DATABASE_URL-guarded harness; never uses production. */
export async function runStatementIdentityDbTests(sql: postgres.Sql, ok: (value: boolean, label: string) => void,
  makePdf: (lines: string[]) => Uint8Array) {
  const check = (value: boolean, label: string) => ok(value, `REG-IDENTITY: ${label}`);
  const previousStorageMode = process.env.STORAGE_MODE;
  process.env.STORAGE_MODE = "local";
  const ids = [randomUUID(), randomUUID()];
  const tokens = ids.map(userId => jwt.sign({ userId, role: "USER", email: `${userId}@test.local` }, process.env.JWT_SECRET!));
  const storage = await import("../app/lib/storage/statement-storage");
  const listRoute = await import("../app/routes/api/documents");
  const deleteRoute = await import("../app/routes/api/documents.$id");
  const paths: string[] = [];
  const identity = parseStatementIdentity("Account Holder Name: Mira Test\nAccount No. TEST1001");
  const save = async (user: number, marker: string, account = identity) => {
    const result = await storage.saveStatementPdf({ userId: ids[user], statementIdentity: account,
      file: new File([makePdf([`Account Holder Name: ${account.accountHolderName}`, `Account No. ${account.accountNumber}`, marker]) as BlobPart], "identity.pdf", { type: "application/pdf" }) });
    if (result.ok) paths.push(result.document.filePath);
    return result;
  };
  const request = (user: number, method = "GET") => new Request("http://test.local/api", { method, headers: { Authorization: `Bearer ${tokens[user]}` } });
  const list = async (user: number) => (await (await listRoute.loader({ request: request(user) } as never)).json()).data;
  const remove = async (id: string, user = 0) => deleteRoute.action({ request: request(user, "DELETE"), params: { id } } as never);
  try {
    for (const id of ids) await sql`INSERT INTO "User" (id,email,password_hash,role,status) VALUES (${id},${id + '@test.local'},'unused-test-hash','USER','ACTIVE')`;
    check(supportedStatementIdentity(await list(0)) === null, "fresh user's documents yield email fallback");
    const a = await save(0, "first");
    const b = await save(0, "second", { ...identity, accountHolderName: "MIRA   Test" });
    check(a.ok && b.ok, "same normalized holder/account persisted across distinct files");
    if (!a.ok || !b.ok) throw new Error("identity fixture save failed");
    const docs = await list(0);
    check(docs.length === 2 && docs.every((d: { accountNumber: string }) => d.accountNumber === identity.accountNumber), "GET returns real per-document fields");
    check((await list(1)).length === 0, "other user cannot read document identity");
    const conflict = await save(0, "foreign", { ...identity, accountHolderName: "Other Holder" });
    check(!conflict.ok && conflict.status === 409 && (await list(0)).length === 2, "foreign holder rejected without document mutation");
    const otherAccount = await save(0, "account", { ...identity, accountNumber: "TEST2002" });
    check(!otherAccount.ok && otherAccount.status === 409, "different account is identity conflict, not duplicate");
    check((await storage.findExistingDocumentByHash(ids[0], a.document.contentHash))?.id === a.document.id, "SHA-256 duplicate identity unchanged");
    check(await storage.findExistingDocumentByHash(ids[1], a.document.contentHash) === null, "duplicate hash lookup remains owner scoped");
    check((await remove(a.document.id, 1)).status === 404, "other user cannot delete identity");
    check((await remove(a.document.id)).status === 200 && supportedStatementIdentity(await list(0)) !== null, "delete one preserves remaining source identity");
    check((await remove(b.document.id)).status === 200 && supportedStatementIdentity(await list(0)) === null, "delete last clears all document-derived identity");
    const concurrent = await Promise.all([save(1, "race-a"), save(1, "race-b", { ...identity, accountHolderName: "Another Person" })]);
    check(concurrent.filter(r => r.ok).length === 1 && concurrent.some(r => !r.ok && r.status === 409), "concurrent first uploads cannot establish conflicting holders");
  } finally {
    for (const id of ids) {
      for (const table of ["journal_entry_lines", "journal_entries", "accounts", "Capital_Transactions", "cost_basis_state", "documents", "notifications", "audit_logs"]) {
        await sql`DELETE FROM ${sql(table)} WHERE user_id=${id}`;
      }
      await sql`DELETE FROM "User" WHERE id=${id}`;
    }
    for (const path of paths) await storage.deleteStoredFile(path);
    if (previousStorageMode === undefined) delete process.env.STORAGE_MODE;
    else process.env.STORAGE_MODE = previousStorageMode;
  }
}
