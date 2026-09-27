// Isolated browser fixture: every fetch is synthetic; no real API or database is used.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { AuthProvider, useAuth } from "../../../app/lib/auth";
import TradingJournalPage from "../../../app/component/DashboardUser/TradingJournalPage";
import DashboardHomePage from "../../../app/component/DashboardUser/DashboardHomePage";
import CashFlowPage from "../../../app/component/DashboardUser/CashFlowPage";
import { parseStatementIdentity } from "../../../app/lib/statement-identity";
import type { ServerDocumentMeta } from "../../../app/lib/server-api";
import "../../../app/app.css";

const requests: string[] = [];
const cash = { totalCashInThb: "0", totalCashOutThb: "0", totalNetThb: "0", rows: [], months: [], exchanges: [], exchangeTotals: [] };
const journal = {
  entries: ["AAPL", "AA", "MSFT"].map((symbol, i) => ({ transactionId: `fixture-${i}`, date: "2026-01-02", symbol, side: "BUY", price: "10", quantity: "1", amount: "10", fees: "0", netAmount: "10", currency: "USD", amountThb: "350", fxRate: "35", avgCostAtTime: 10, note: null, dividendPerShare: null })),
  holdings: [], totals: { tradeCount: 3, buyCount: 3, sellCount: 0, dividendCount: 0 },
};
window.fetch = async (input) => {
  const url = String(input);
  requests.push(url);
  document.getElementById("requests")!.textContent = JSON.stringify(requests);
  await new Promise(resolve => setTimeout(resolve, 30));
  let data: unknown = {};
  if (url.includes("auth/login")) data = { accessToken: "fixture-only", user: { id: "fixture-user", email: "fixture-user@example.test", role: "USER" } };
  else if (url.includes("trading-journal")) data = journal;
  else if (url.includes("cash-summary")) data = cash;
  else if (url.includes("cost-basis")) data = [];
  else if (url.includes("monthly-closing")) data = { months: [] };
  else if (url.includes("ledger/summary")) data = { groups: [], totals: {}, totalsThb: {}, totalsByCurrency: [] };
  return Response.json({ success: true, data });
};
const nativePicker = HTMLInputElement.prototype.showPicker;
HTMLInputElement.prototype.showPicker = function () {
  const output = document.getElementById("picker-calls")!;
  output.textContent = String(Number(output.textContent) + 1);
  nativePicker?.call(this);
};
function Fixture() {
  const { user, login } = useAuth();
  const [view, setView] = useState("journal");
  const [documents, setDocuments] = useState<ServerDocumentMeta[]>([]);
  const doc = (id: string): ServerDocumentMeta => ({ id, originalName: `${id}.pdf`, mimeType: "application/pdf", fileSize: 1, createdAt: "2026-01-01", transactionCount: 1,
    ...parseStatementIdentity("Account Holder Name: Mira Fixture\nAccount No. FIX1001") });
  return <>
    <nav className="flex gap-3 p-3 bg-gray-200">
      <button onClick={() => void login("fixture-user@example.test", "fixture-only")}>Fixture login</button>
      <button onClick={() => setView("journal")}>Journal fixture</button>
      <button onClick={() => setView("dashboard")}>Dashboard fixture</button>
      <button onClick={() => setView("cash")}>Cash fixture</button>
      <button onClick={() => setDocuments([doc("first"), doc("second")])}>Import two documents</button>
      <button onClick={() => setDocuments(previous => previous.slice(1))}>Delete one document</button>
      <button onClick={() => setDocuments([])}>Delete all documents</button>
    </nav>
    <output id="requests" className="block text-xs break-all" />
    <output id="picker-calls">0</output>
    {user && <main className="p-5">{view === "journal" ? <TradingJournalPage onOpenSymbol={() => {}} /> : view === "cash" ? <CashFlowPage /> : <DashboardHomePage transactions={[]} documents={documents} onNavigate={() => {}} onOpenSymbol={() => {}} />}</main>}
  </>;
}
createRoot(document.getElementById("root")!).render(<AuthProvider><Fixture /></AuthProvider>);
