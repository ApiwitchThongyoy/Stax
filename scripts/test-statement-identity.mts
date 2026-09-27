import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseStatementIdentity as parse, normalizeHolderName, validateStatementIdentity as validate, supportedStatementIdentity as supported } from "../app/lib/statement-identity";
import { extractTextFromPdfBytes } from "../app/lib/pdf-text-extractor";

let passed = 0;
function test(name: string, run: () => void) { run(); passed++; console.log(`PASS ${name}`); }
const first = parse("Account Holder Name: Mira Test\nAccount No.: TEST1001");
test("explicit source fields", () => assert.deepEqual(first, { accountHolderName: "Mira Test", accountNumber: "TEST1001" }));
test("inline fields", () => assert.deepEqual(parse("Account Holder Name: Mira Test Account No. TEST1001"), first));
test("next-line values", () => assert.deepEqual(parse("Account Holder Name:\nMira Test\nAccount Number:\nTEST1001"), first));
test("preserve display spacing and case", () => assert.equal(parse("Account Holder Name: MIRA   Test\nAccount No. TEST1001").accountHolderName, "MIRA   Test"));
test("normalized comparison", () => assert.equal(normalizeHolderName("  MIRA   Test "), "mira test"));
test("same identity imports normally", () => assert.deepEqual(validate({ ...first, accountHolderName: " mira  TEST " }, [first]), []));
test("different holder rejected", () => assert.throws(() => validate({ ...first, accountHolderName: "Other Holder" }, [first])));
test("same holder different account rejected as identity conflict, not duplicate", () => assert.throws(() => validate({ ...first, accountNumber: "TEST2002" }, [first]), /ไม่ใช่ไฟล์ซ้ำ/));
test("missing fields never invented", () => assert.deepEqual(parse("Statement for customer\nrandom@example.test"), { accountHolderName: null, accountNumber: null }));
test("missing identity warns without breaking legacy imports", () => assert.equal(validate(parse(""), [first]).length, 1));
test("unknown existing document warns", () => assert.equal(validate(first, [parse("")]).length, 1));
test("ambiguous holder rejected as evidence", () => assert.equal(parse("Account Holder Name: Mira Test\nAccount Holder Name: Other Holder").accountHolderName, null));
test("ambiguous account rejected as evidence", () => assert.equal(parse("Account No. TEST1001\nAccount No. TEST2002").accountNumber, null));
test("repeated page identity accepted", () => assert.deepEqual(parse("Account Holder Name: Mira Test\nAccount No. TEST1001\nAccount Holder Name: MIRA TEST\nAccount No. TEST1001"), { ...first, accountHolderName: "MIRA TEST" }));
test("masked number remains unknown", () => assert.equal(parse("Account No. TEST****").accountNumber, null));
test("fresh user email fallback", () => assert.equal(supported([]), null));
test("multiple remaining documents support identity", () => assert.deepEqual(supported([first, first]), first));
test("delete one preserves supported identity", () => assert.deepEqual(supported([first]), first));
test("delete final clears identity", () => assert.equal(supported([first].slice(1)), null));
test("remaining unknown document cannot retain deleted identity", () => assert.equal(supported([{}]), null));
test("conflicting legacy identities do not pick arbitrary owner", () => assert.equal(supported([first, { ...first, accountNumber: "TEST2002" }]), null));
test("partial fields from different documents never combined", () => assert.equal(supported([{ accountHolderName: "Mira Test" }, { accountNumber: "TEST1001" }]), null));
test("blank field cannot consume another label", () => assert.equal(parse("Account Holder Name:\nAccount No. TEST1001").accountHolderName, null));

// Exercise the real PDF extractor before parsing, not only handcrafted extracted text.
const lines = ["Account Holder Name: Mira Test", "Account No.: TEST1001"];
const stream = "BT /F1 12 Tf 50 750 Td " + lines.map((line, i) => `${i ? "0 -20 Td " : ""}(${line}) Tj`).join(" ") + " ET";
const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
let pdf = "%PDF-1.4\n";
const offsets = [0];
objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
const xref = pdf.length;
pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
const extracted = await extractTextFromPdfBytes(new Uint8Array(Buffer.from(pdf)));
test("real PDF text extraction feeds identity parser", () => { assert(extracted.ok); assert.deepEqual(parse(extracted.text), first); });
test("delete callback refreshes Dashboard document source", () => assert.match(readFileSync("app/component/DashboardUser/Dashboard.tsx", "utf8"), /onDocumentDeleted=\{refreshServerData\}/));
console.log(`Statement identity: ${passed} PASS / 0 FAIL`);
