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

// ---------------------------------------------------------------------------
// Real Webull statement layout (structure verified against a real 7-page Webull
// PDF). Synthetic placeholder values only: no real person name and no real
// account number appear in this fixture.
//
//   Webull Securities (Thailand) Co. Ltd.        <- broker + its own address
//   ...
//   Monthly Account Statement                    <- header anchor
//   Period:...                                   <- metadata anchor
//   Date of Issuance:...                         <- metadata anchor
//   <holder name>                                <- STANDALONE, unlabelled
//   Address : <address text> Account No. : <no>  <- address AND number share ONE line
//   ... Account Type : CASH
//   Base Currency : THB
//   Base Currency Rate: ...                      <- must never be read as a name
// ---------------------------------------------------------------------------
const WEBULL_REAL_LAYOUT = [
  "Webull Securities (Thailand) Co. Ltd.",
  "496,498,500,502 Amarin Tower Building,",
  "12th Floor, Unit 1, Ploen Chit Rd, Lumpini,",
  "Pathumwan, Bangkok 10330, Thailand",
  "VAT ID 0105565018365",
  "Monthly Account Statement",
  "Period:01/06/2026 - 30/06/2026",
  "Date of Issuance:02/07/2026",
  "Placeholder Holder",
  "Address : 19 Sample Road Unit 5 Account No. : TEST1001",
  "Mueang Sample Phayao TH 56000 Account Type : CASH",
  "Base Currency : THB",
  "Base Currency Rate: HKD/THB = 4.243",
  "USD/THB = 33.27",
].join("\n");
const webullIdentity = { accountHolderName: "Placeholder Holder", accountNumber: "TEST1001" };

test("real Webull layout: unlabelled standalone holder name and account number parsed", () => assert.deepEqual(parse(WEBULL_REAL_LAYOUT), webullIdentity));
test("real Webull layout: name parsed even when the number label is missing", () => assert.equal(parse(WEBULL_REAL_LAYOUT.replace(/Account No\. : TEST1001/u, "Account No. :")).accountHolderName, "Placeholder Holder"));
test("real Webull layout: simplified separate-label form parses identically", () => assert.deepEqual(parse([
  "Monthly Account Statement",
  "Period:01/06/2026 - 30/06/2026",
  "Date of Issuance:02/07/2026",
  "Placeholder Holder",
  "Address: 19 Sample Road Unit 5",
  "Account No. : TEST1001",
  "Account Type : CASH",
  "Base Currency : THB",
].join("\n")), webullIdentity));
test("broker and company address lines above the header are never the holder name", () => assert.deepEqual(parse(WEBULL_REAL_LAYOUT).accountHolderName, "Placeholder Holder"));
test("account holder address text is never used as the holder name", () => {
  const identity = parse(WEBULL_REAL_LAYOUT);
  assert.notEqual(identity.accountHolderName, "19 Sample Road Unit 5");
  assert.notEqual(identity.accountHolderName, "Mueang Sample Phayao TH 56000");
});
test("Account Type label is never consumed as a name or a number", () => {
  const text = WEBULL_REAL_LAYOUT.replace("Placeholder Holder", "Account Type : CASH");
  assert.deepEqual(parse(text), { accountHolderName: null, accountNumber: "TEST1001" });
});
test("Base Currency label is never consumed as a name", () => {
  assert.deepEqual(parse(WEBULL_REAL_LAYOUT.replace("Placeholder Holder", "Base Currency : THB")).accountHolderName, null);
});
test("Base Currency Rate label is never consumed as a name", () => {
  assert.deepEqual(parse(WEBULL_REAL_LAYOUT.replace("Placeholder Holder", "Base Currency Rate: HKD/THB = 4.243")).accountHolderName, null);
});
test("Address label in the gap never produces a name", () => {
  assert.equal(parse(WEBULL_REAL_LAYOUT.replace("Placeholder Holder", "Address")).accountHolderName, null);
});
test("no Webull header: standalone line is not evidence", () => assert.equal(parse([
  "Statement for customer",
  "Date of Issuance:02/07/2026",
  "Placeholder Holder",
  "Address: 19 Sample Road",
  "Account No. : TEST1001",
].join("\n")).accountHolderName, null));
test("missing Address anchor: no standalone name", () => assert.equal(parse([
  "Monthly Account Statement",
  "Period:01/06/2026 - 30/06/2026",
  "Date of Issuance:02/07/2026",
  "Placeholder Holder",
  "Account No. : TEST1001",
].join("\n")).accountHolderName, null));
test("missing statement metadata anchor: no standalone name", () => assert.equal(parse([
  "Monthly Account Statement",
  "Placeholder Holder",
  "Address : 19 Sample Road Account No. : TEST1001",
].join("\n")).accountHolderName, null));
test("two standalone lines in the header gap stay ambiguous", () => assert.deepEqual(parse(WEBULL_REAL_LAYOUT.replace("Placeholder Holder", "Placeholder Holder\nCo Holder Line")), { accountHolderName: null, accountNumber: "TEST1001" }));
test("empty header gap yields no name", () => assert.equal(parse(WEBULL_REAL_LAYOUT.replace("Placeholder Holder\n", "")).accountHolderName, null));
test("repeated Webull header with the same name is accepted", () => assert.deepEqual(parse(`${WEBULL_REAL_LAYOUT}\nMonthly Account Statement\nPeriod:01/07/2026 - 31/07/2026\nDate of Issuance:02/08/2026\nplaceholder   holder\nAddress : 19 Sample Road Account No. : TEST1001`), { ...webullIdentity, accountHolderName: "placeholder   holder" }));
test("repeated Webull header with a different name stays ambiguous", () => assert.equal(parse(`${WEBULL_REAL_LAYOUT}\nMonthly Account Statement\nPeriod:01/07/2026 - 31/07/2026\nDate of Issuance:02/08/2026\nOther Holder\nAddress : 19 Sample Road Account No. : TEST1001`).accountHolderName, null));
test("standalone name conflicting with an explicit label is a conflict, not a silent win", () => assert.equal(parse(`Account Holder Name: Different Holder\n${WEBULL_REAL_LAYOUT}`).accountHolderName, null));
test("standalone name agreeing with an explicit label is accepted", () => assert.deepEqual(parse(`Account Holder Name: PLACEHOLDER HOLDER\n${WEBULL_REAL_LAYOUT}`), { accountHolderName: "PLACEHOLDER HOLDER", accountNumber: "TEST1001" }));
test("non-name gap content (currency figure) is rejected", () => assert.equal(parse(WEBULL_REAL_LAYOUT.replace("Placeholder Holder", "1,234.56")).accountHolderName, null));
test("real layout identity keeps conflict protection", () => {
  assert.throws(() => validate(webullIdentity, [{ accountHolderName: "Other Holder", accountNumber: "TEST1001" }]));
  assert.throws(() => validate(webullIdentity, [{ accountHolderName: "Placeholder Holder", accountNumber: "TEST2002" }]), /ไม่ใช่ไฟล์ซ้ำ/u);
  assert.deepEqual(validate(webullIdentity, [webullIdentity]), []);
});
test("real layout documents support one owner", () => assert.deepEqual(supported([webullIdentity, webullIdentity]), webullIdentity));
test("every accepted Account No. label form", () => {
  for (const label of ["Account No. : TEST1001", "Account No.: TEST1001", "Account No : TEST1001", "Account Number : TEST1001", "Account Number: TEST1001"]) {
    assert.equal(parse(WEBULL_REAL_LAYOUT.replace("Account No. : TEST1001", label)).accountNumber, "TEST1001", label);
  }
});

// Exercise the real PDF extractor before parsing, not only handcrafted extracted text.
function buildPdf(lines: string[]): Uint8Array {
  const stream = "BT /F1 12 Tf 50 750 Td " + lines.map((line, i) => `${i ? "0 -20 Td " : ""}(${line.replace(/([()\\])/gu, "\\$1")}) Tj`).join(" ") + " ET";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>", `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return new Uint8Array(Buffer.from(pdf));
}
const extracted = await extractTextFromPdfBytes(buildPdf(["Account Holder Name: Mira Test", "Account No.: TEST1001"]));
test("real PDF text extraction feeds identity parser", () => { assert(extracted.ok); assert.deepEqual(parse(extracted.text), first); });

// The same must hold end to end for the real Webull header layout, extracted
// from PDF bytes rather than from a handcrafted string.
const webullExtracted = await extractTextFromPdfBytes(buildPdf(WEBULL_REAL_LAYOUT.split("\n")));
test("real PDF of the Webull header layout yields holder name and account number", () => { assert(webullExtracted.ok); assert.deepEqual(parse(webullExtracted.text), webullIdentity); });
test("delete callback refreshes Dashboard document source", () => assert.match(readFileSync("app/component/DashboardUser/Dashboard.tsx", "utf8"), /onDocumentDeleted=\{refreshServerData\}/));
console.log(`Statement identity: ${passed} PASS / 0 FAIL`);
