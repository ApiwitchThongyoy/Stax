import { useCallback, useEffect, useState } from "react";
import {
  LineChart,
  WifiOff,
  Wifi,
  Calculator,
  Sparkles,
  Loader2,
  CheckCircle2,
  AlertTriangle,
} from "lucide-react";
import PdfStatementUploader from "./PdfStatementUploader";
import type { Transaction } from "../../lib/Financeutils";
import type { ExtractedTransaction } from "../../lib/pdfStatementParser";
import type {
  AiResult,
  AiGeminiStatementResult,
} from "../../lib/ai-result";
import { useAuth } from "../../lib/auth";
import {
  useSuspendedAccount,
  flagSuspendedFromResponse,
} from "../../lib/suspended-account";
import { loadLatestGeminiAnalysis } from "../../lib/gemini-analysis-storage";
import {
  fetchExchangeRate,
  fetchAiAnalysis,
  type ExchangeRateEntry,
  type AiAnalysisResponse,
} from "../../lib/server-api";

interface FxAiPageProps {
  transactions: Transaction[];
  onImport: (imported: ExtractedTransaction[]) => void;
  onDocumentSaved?: () => void;
}

// Shape of the real rows returned by GET /api/v1/capital-ledgers.
interface ApiCapitalTransaction {
  transactionId: string;
  amountForeign: string;
  currency: string;
  transactionDate: string;
  fxRateBot: string;
  amountThb: string;
  type: string;
  sourceType: string;
}

// Shape of the real per-transaction rows from POST /api/v1/tax/calculate.
interface TaxRowResponse {
  transactionId: string;
  transactionDate?: string | null;
  currency?: string | null;
  transactionAmountThb: string;
  realizedGainLossThb: string | null;
  taxableAmountThb: string | null;
  isTaxable: boolean | null;
  status: "computable" | "not-computable";
  classification:
    | "realized-gain"
    | "non-computable"
    | "buy-basis"
    | "not-applicable";
  reason: string;
  symbol?: string | null;
  side?: "BUY" | "SELL" | null;
  quantity?: string | null;
  unitPrice?: string | null;
  grossAmount?: string | null;
  fees?: string | null;
  proceeds?: string | null;
  costBasis?: string | null;
  realizedGainLoss?: string | null;
  fxRateStatement?: string | null;
  fxRateEffective?: string | null;
  exchange?: string | null;
}

interface TaxResponse {
  success: boolean;
  message?: string;
  data?: {
    computable: boolean;
    computedCount: number;
    nonComputableCount: number;
    reason: string;
    transactions: TaxRowResponse[];
    totalTaxableAmountThb: string | null;
  };
}

type Aiphase =
  | { phase: "idle" }
  | { phase: "success"; result: AiGeminiStatementResult }
  | { phase: "unavailable"; code: string; errors: string[] };

type TaxPhase =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "success"; data: NonNullable<TaxResponse["data"]> }
  | { phase: "error"; message: string };

export default function FxAiPage({
  transactions,
  onImport,
  onDocumentSaved,
}: FxAiPageProps) {
  const { user, logout } = useAuth();
  const { suspended, markSuspended } = useSuspendedAccount();

  const [aiPhase, setAiPhase] = useState<Aiphase>({ phase: "idle" });
  const [taxPhase, setTaxPhase] = useState<TaxPhase>({ phase: "idle" });
  const [fxEntry, setFxEntry] = useState<ExchangeRateEntry | null>(null);
  const [insight, setInsight] = useState<AiAnalysisResponse | null>(null);
  const [insightLoading, setInsightLoading] = useState(false);

  const fxRows = transactions.filter(
    (t) => t.rate && t.rate.trim() !== "" && t.rate !== "-"
  );

  const authHeaders = (): Record<string, string> => {
    if (!user?.accessToken) {
      logout();
      return {};
    }
    return { Authorization: `Bearer ${user.accessToken}` };
  };

  const loadTax = useCallback(async () => {
    if (suspended) return;
    setTaxPhase({ phase: "loading" });

    let ledgerRes: Response;
    try {
      ledgerRes = await fetch("/api/v1/capital-ledgers", {
        headers: authHeaders(),
      });
    } catch {
      setTaxPhase({ phase: "error", message: "ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้" });
      return;
    }
    if (ledgerRes.status === 401) {
      logout();
      return;
    }
    if (await flagSuspendedFromResponse(ledgerRes, markSuspended)) {
      return;
    }

    let ledgerData: { success?: boolean; data?: ApiCapitalTransaction[] };
    try {
      ledgerData = await ledgerRes.json();
    } catch {
      ledgerData = {};
    }
    if (!ledgerRes.ok || !ledgerData.success || !Array.isArray(ledgerData.data)) {
      setTaxPhase({ phase: "error", message: "ดึงธุรกรรมไม่สำเร็จ" });
      return;
    }

    const ids = ledgerData.data
      .map((t) => t.transactionId)
      .filter((id): id is string => typeof id === "string" && id.length > 0);
    if (ids.length === 0) {
      setTaxPhase({ phase: "success", data: { computable: false, computedCount: 0, nonComputableCount: 0, reason: "ไม่มีธุรกรรม", transactions: [], totalTaxableAmountThb: null } });
      return;
    }

    let taxRes: Response;
    try {
      taxRes = await fetch("/api/v1/tax/calculate", {
        method: "POST",
        headers: { ...authHeaders(), "Content-Type": "application/json" },
        body: JSON.stringify({ transactionIds: ids }),
      });
    } catch {
      setTaxPhase({ phase: "error", message: "ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้" });
      return;
    }
    if (taxRes.status === 401) {
      logout();
      return;
    }
    if (await flagSuspendedFromResponse(taxRes, markSuspended)) {
      return;
    }

    let data: TaxResponse;
    try {
      data = await taxRes.json();
    } catch {
      data = { success: false };
    }
    if (!taxRes.ok || !data.success || !data.data) {
      setTaxPhase({ phase: "error", message: data.message || "การคำนวณภาษีไม่สำเร็จ" });
      return;
    }
    setTaxPhase({ phase: "success", data: data.data });
  }, [user?.accessToken, suspended, markSuspended, logout]);

  // Reload tax whenever the imported transaction set changes (after an import).
  useEffect(() => {
    void loadTax();
  }, [loadTax, transactions]);

  // Restore the latest validated Gemini analysis from this browser session
  // (e.g. an upload performed on the Dashboard) when this page mounts.
  useEffect(() => {
    const stored = loadLatestGeminiAnalysis();
    if (stored) {
      setAiPhase({ phase: "success", result: stored.result });
    }
  }, []);

  // Fetch today's real external USD/THB rate from the Historical FX Provider.
  // The server is authoritative — on failure/weekend/holiday it returns
  // { available: false }, never a fabricated rate. Statement-sourced rates take
  // priority; this external rate powers the FX status card below.
  useEffect(() => {
    if (!user?.accessToken || suspended) return;
    let cancelled = false;
    fetchExchangeRate(user.accessToken, "USD")
      .then((entry) => {
        if (!cancelled) setFxEntry(entry);
      })
      .catch(() => {
        if (!cancelled)
          setFxEntry({ available: false, date: "", reason: "network error" });
      });
    return () => {
      cancelled = true;
    };
  }, [user?.accessToken, suspended]);

  // Fetch neutral AI insights about the imported activity. When Gemini is
  // unavailable the server returns { available: false } — shown truthfully.
  useEffect(() => {
    if (!user?.accessToken || suspended) return;
    let cancelled = false;
    setInsightLoading(true);
    fetchAiAnalysis(user.accessToken)
      .then((data) => {
        if (!cancelled) setInsight(data);
      })
      .catch(() => {
        if (!cancelled)
          setInsight({ available: false, code: "NETWORK_ERROR", errors: [] });
      })
      .finally(() => {
        if (!cancelled) setInsightLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [user?.accessToken, suspended, transactions]);

  const handleGeminiResult = (ai: AiResult) => {
    if (ai.source === "gemini") {
      setAiPhase({ phase: "success", result: ai.result });
    } else {
      setAiPhase({ phase: "unavailable", code: ai.code, errors: ai.errors });
    }
  };

  const aiFailureMessage = (code: string): string => {
    switch (code) {
      case "GEMINI_NOT_CONFIGURED":
        return "ยังไม่ได้ตั้งค่า Gemini API";
      case "GEMINI_REQUEST_FAILED":
        return "การเรียกใช้ Gemini เกิดข้อผิดพลาด (GEMINI_REQUEST_FAILED)";
      case "GEMINI_SCHEMA_VALIDATION_FAILED":
        return "ผลลัพธ์จาก Gemini ไม่ผ่านการตรวจสอบ Schema (GEMINI_SCHEMA_VALIDATION_FAILED)";
      default:
        return "การวิเคราะห์ Statement ไม่สำเร็จ";
    }
  };

  // Classification → Thai status. The server's `classification` field is
  // authoritative (backend verdict); this is display text only, no calculation
  // happens in React.
  const taxStatusLabel = (t: TaxRowResponse): { text: string; cls: string } => {
    switch (t.classification) {
      case "realized-gain":
        return {
          text: t.isTaxable
            ? "คำนวณได้ · กำไรต้องเสียภาษี"
            : "คำนวณได้ · ขาดทุน (ไม่หักกลบ)",
          cls: "text-emerald-600",
        };
      case "non-computable":
        return {
          text: "ยังไม่สามารถคำนวณภาษีรายการนี้ได้",
          cls: "text-amber-600",
        };
      case "buy-basis":
        return { text: "รายการซื้อ / รอใช้เป็นต้นทุน", cls: "text-blue-600" };
      case "not-applicable":
      default:
        return {
          text: "ไม่ใช่รายการกำไรที่ต้องคำนวณ",
          cls: "text-gray-500",
        };
    }
  };

  const taxReasonLabel = (t: TaxRowResponse): string => {
    switch (t.classification) {
      case "realized-gain":
        return `กำไร/ขาดทุนรับรู้: ${t.realizedGainLoss ?? "-"} · ฐานภาษี: ฿${t.taxableAmountThb}`;
      case "non-computable":
        return "ขาดต้นทุนอ้างอิงที่น่าเชื่อถือ (ไม่มีประวัติการซื้อที่เพียงพอ) จึงคำนวณกำไร/ขาดทุนไม่ได้";
      case "buy-basis":
        return "ใช้เป็นต้นทุนเมื่อมีการขาย (SELL) ในอนาคต";
      case "not-applicable":
      default:
        return "เงินฝาก/ถอน ค่าธรรมเนียม หรือรายการที่มิใช่กำไรจากการขายหุ้น ไม่ถูกนำมาคำนวณ";
    }
  };

  const statusCards: {
    key: string;
    title: string;
    message: string;
    detail: string;
    Icon: typeof WifiOff;
  }[] = [
    {
      key: "fx",
      title: "อัตราแลกเปลี่ยน (Historical FX Provider)",
      message:
        fxEntry === null
          ? "กำลังตรวจสอบ..."
          : fxEntry.available && fxEntry.rate != null
          ? `USD/THB ≈ ฿${fxEntry.rate.toFixed(4)}`
          : "ไม่พร้อมใช้งาน",
      detail:
        fxEntry === null
          ? "กำลังตรวจสอบอัตราจาก Historical FX Provider"
          : fxEntry.available && fxEntry.rate != null
          ? `อัตราอ้างอิงจาก Historical FX Provider ณ วันที่ ${fxEntry.date} (${fxEntry.source ?? "historical-fx-provider"})`
          : fxEntry.reason ||
            "ไม่สามารถดึงอัตราได้ (Historical FX Provider ไม่มีข้อมูล หรือเป็นวันหยุดตลาด)",
      Icon: fxEntry?.available ? Wifi : WifiOff,
    },
    {
      key: "ai",
      title: "ระบบวิเคราะห์ AI",
      message:
        aiPhase.phase === "success"
          ? "วิเคราะห์ Statement สำเร็จ"
          : aiPhase.phase === "unavailable"
          ? aiFailureMessage(aiPhase.code)
          : "ยังไม่ได้วิเคราะห์ Statement",
      detail:
        "AI ใช้วิเคราะห์โครงสร้างของ Statement เท่านั้น ไม่ได้เป็นผู้คำนวณภาษี",
      Icon: aiPhase.phase === "success" ? CheckCircle2 : Sparkles,
    },
    {
      key: "tax",
      title: "การคำนวณภาษี",
      message: "Tax Core Engine พร้อมใช้งาน",
      detail:
        "คำนวณรายธุรกรรมแบบกำหนดได้ (deterministic) ด้วยเลขทศนิยม ไม่ให้ขาดทุนหักกลบข้ามรายการ",
      Icon: Calculator,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Banner */}
      <div className="bg-linear-to-br from-blue-900 to-blue-950 rounded-2xl px-6 py-5 text-white">
        <p className="text-xs text-blue-300 mb-1">Foreign Exchange & AI</p>
        <h1 className="text-xl font-semibold mb-1.5">อัตราแลกเปลี่ยน AI</h1>
        <p className="text-sm text-blue-200">
          อัตราแลกเปลี่ยนจาก Statement ที่ import และสถานะการเชื่อมต่อบริการภายนอก
        </p>
      </div>

      {/* Real FX data from imported statements */}
      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-800">
            อัตราแลกเปลี่ยน ณ วันที่ทำรายการ
          </h2>
          {fxRows.length > 0 && (
            <span className="text-xs text-gray-400">
              {fxRows.length} รายการ · จาก Statement ที่ import
            </span>
          )}
        </div>

        {fxRows.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <LineChart className="w-8 h-8 text-gray-300 mx-auto mb-3" />
            <p className="text-sm font-medium text-gray-600">
              ยังไม่มีข้อมูลอัตราแลกเปลี่ยนจาก Statement ที่ import
            </p>
            <p className="text-xs text-gray-400 mt-1">
              นำเข้า Statement PDF ด้านล่างเพื่อแสดงอัตราที่ใช้จริงในแต่ละรายการ
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                  <th className="px-5 py-3 font-medium">วันที่</th>
                  <th className="px-5 py-3 font-medium">รายการ</th>
                  <th className="px-5 py-3 font-medium">สกุลเงิน</th>
                  <th className="px-5 py-3 font-medium">อัตรา</th>
                </tr>
              </thead>
              <tbody>
                {fxRows.map((t) => (
                  <tr
                    key={t.id}
                    className="border-b border-gray-50 last:border-0 hover:bg-gray-50/60 transition"
                  >
                    <td className="px-5 py-3.5 text-gray-500 whitespace-nowrap">
                      {t.date}
                    </td>
                    <td className="px-5 py-3.5">
                      <p className="text-gray-800 font-medium truncate max-w-[260px]">
                        {t.description}
                      </p>
                    </td>
                    <td className="px-5 py-3.5 text-gray-500 whitespace-nowrap">
                      {t.currency}
                    </td>
                    <td className="px-5 py-3.5 text-gray-800 font-medium whitespace-nowrap">
                      {t.rate}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Integration status */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {statusCards.map(({ key, title, message, detail, Icon }) => (
          <div
            key={key}
            className="bg-white rounded-xl border border-gray-100 p-5"
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs text-gray-400">{title}</span>
              <Icon className="w-4 h-4 text-gray-400" />
            </div>
            <p className="text-sm font-medium text-gray-800">{message}</p>
            <p className="text-xs text-gray-400 mt-1.5 leading-relaxed">
              {detail}
            </p>
          </div>
        ))}
      </div>

      {/* Gemini structured analysis result (real, from the upload response) */}
      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-blue-800" />
            <h2 className="text-sm font-semibold text-gray-800">
              ผลการวิเคราะห์ Statement ด้วย Gemini
            </h2>
          </div>
          {aiPhase.phase === "success" && (
            <span className="text-xs text-emerald-600 font-medium">
              วิเคราะห์ Statement สำเร็จ
            </span>
          )}
        </div>

        {aiPhase.phase === "idle" && (
          <div className="px-5 py-12 text-center">
            <Sparkles className="w-8 h-8 text-gray-300 mx-auto mb-3" />
            <p className="text-sm font-medium text-gray-600">
              ยังไม่ได้วิเคราะห์ Statement
            </p>
            <p className="text-xs text-gray-400 mt-1">
              อัปโหลด Statement PDF ด้านล่างเพื่อวิเคราะห์โครงสร้างด้วย Gemini
            </p>
          </div>
        )}

        {aiPhase.phase === "unavailable" && (
          <div className="px-5 py-10 text-center">
            <AlertTriangle className="w-8 h-8 text-amber-400 mx-auto mb-3" />
            <p className="text-sm font-medium text-gray-700">
              {aiFailureMessage(aiPhase.code)}
            </p>
            <p className="text-xs text-gray-400 mt-1">
              รหัสข้อผิดพลาดจาก backend: {aiPhase.code}
            </p>
            {aiPhase.errors.map((e) => (
              <p key={e} className="text-xs text-gray-400 mt-1">
                {e}
              </p>
            ))}
            <p className="text-xs text-gray-400 mt-3">
              ระบบยังคงใช้การนำเข้า Statement แบบกำหนดได้ (deterministic)
              ตามเดิม
            </p>
          </div>
        )}

        {aiPhase.phase === "success" && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                  <th className="px-5 py-3 font-medium">วันที่</th>
                  <th className="px-5 py-3 font-medium">รายการ</th>
                  <th className="px-5 py-3 font-medium">ประเภท</th>
                  <th className="px-5 py-3 font-medium">สกุลเงิน</th>
                  <th className="px-5 py-3 font-medium text-right">ยอด</th>
                  <th className="px-5 py-3 font-medium text-right">อัตรา</th>
                  <th className="px-5 py-3 font-medium text-right">บาท</th>
                  <th className="px-5 py-3 font-medium text-right">ความมั่นใจ</th>
                </tr>
              </thead>
              <tbody>
                {aiPhase.result.statement.transactions.map((t, i) => (
                  <tr
                    key={`${t.transactionDate}-${i}`}
                    className="border-b border-gray-50 last:border-0"
                  >
                    <td className="px-5 py-3 text-gray-500 whitespace-nowrap">
                      {t.transactionDate}
                    </td>
                    <td className="px-5 py-3 text-gray-800 font-medium">
                      {t.description}
                    </td>
                    <td className="px-5 py-3 text-gray-500">{t.transactionType}</td>
                    <td className="px-5 py-3 text-gray-500">{t.currency}</td>
                    <td className="px-5 py-3 text-gray-800 font-medium text-right whitespace-nowrap">
                      {t.amount}
                    </td>
                    <td className="px-5 py-3 text-gray-500 text-right">
                      {t.exchangeRate ?? "-"}
                    </td>
                    <td className="px-5 py-3 text-gray-500 text-right">
                      {t.amountThb ?? "-"}
                    </td>
                    <td className="px-5 py-3 text-gray-500 text-right">
                      {t.confidence != null
                        ? `${(t.confidence * 100).toFixed(0)}%`
                        : "-"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {aiPhase.result.statement.warnings.length > 0 && (
              <div className="px-5 py-3 border-t border-gray-100 bg-amber-50/40">
                <p className="text-xs font-medium text-amber-600 mb-1">คำเตือน</p>
                {aiPhase.result.statement.warnings.map((w, i) => (
                  <p key={i} className="text-xs text-amber-700 leading-relaxed">
                    • {w}
                  </p>
                ))}
              </div>
            )}
            <p className="px-5 py-3 text-xs text-gray-400">
              ผลลัพธ์นี้มาจากการวิเคราะห์โครงสร้างของ Gemini เท่านั้น
              ไม่ใช่การคำนวณภาษีที่เชื่อถือได้
            </p>
          </div>
        )}
      </div>

      {/* Tax reconstruction (real, from /api/v1/tax/calculate) */}
      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <Calculator className="w-4 h-4 text-blue-800" />
            <h2 className="text-sm font-semibold text-gray-800">
              การคำนวณฐานภาษี (Tax Core Engine)
            </h2>
          </div>
          {taxPhase.phase === "loading" && (
            <span className="flex items-center gap-1 text-xs text-gray-400">
              <Loader2 className="w-3.5 h-3.5 animate-spin" /> กำลังคำนวณ...
            </span>
          )}
        </div>

        {taxPhase.phase === "idle" && (
          <div className="px-5 py-12 text-center">
            <Calculator className="w-8 h-8 text-gray-300 mx-auto mb-3" />
            <p className="text-sm font-medium text-gray-600">
              ดึงข้อมูลธุรกรรมเพื่อคำนวณฐานภาษี
            </p>
          </div>
        )}

        {taxPhase.phase === "error" && (
          <div className="px-5 py-10 text-center">
            <AlertTriangle className="w-8 h-8 text-amber-400 mx-auto mb-3" />
            <p className="text-sm font-medium text-gray-700">
              การคำนวณภาษีไม่สำเร็จ
            </p>
            <p className="text-xs text-gray-400 mt-1">{taxPhase.message}</p>
          </div>
        )}

        {taxPhase.phase === "success" && (
          <>
            <div className="px-5 py-4 border-b border-gray-100">
              {taxPhase.data.totalTaxableAmountThb === null ? (
                <>
                  <p className="text-sm font-semibold text-amber-600">
                    ยังไม่สามารถคำนวณฐานภาษีรวมได้ เนื่องจากข้อมูลต้นทุนยังไม่ครบ
                  </p>
                  <p className="text-xs text-gray-400 mt-1">
                    {taxPhase.data.reason}
                  </p>
                </>
              ) : (
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-gray-800">
                    ฐานภาษีที่คำนวณได้ (รวม): ฿
                    {taxPhase.data.totalTaxableAmountThb}
                  </p>
                  {(taxPhase.data.nonComputableCount ?? 0) > 0 && (
                    <span className="text-xs text-amber-600">
                      {taxPhase.data.nonComputableCount} รายการยังคำนวณไม่ได้ ·
                      คำนวณได้ {taxPhase.data.computedCount ?? 0} รายการ
                    </span>
                  )}
                </div>
              )}
            </div>

            {taxPhase.data.transactions.length === 0 ? (
              <div className="px-5 py-10 text-center">
                <p className="text-sm font-medium text-gray-600">
                  ยังไม่มีธุรกรรมที่จะคำนวณ
                </p>
                <p className="text-xs text-gray-400 mt-1">
                  นำเข้า Statement หรือเพิ่มรายการก่อน
                </p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                      <th className="px-5 py-3 font-medium">วันที่</th>
                      <th className="px-5 py-3 font-medium">สัญลักษณ์</th>
                      <th className="px-5 py-3 font-medium">ประเภท</th>
                      <th className="px-5 py-3 font-medium text-right">จำนวน</th>
                      <th className="px-5 py-3 font-medium text-right">ราคา/หน่วย</th>
                      <th className="px-5 py-3 font-medium text-right">ยอดรวม</th>
                      <th className="px-5 py-3 font-medium text-right">ค่าธรรมเนียม</th>
                      <th className="px-5 py-3 font-medium text-right">ต้นทุน</th>
                      <th className="px-5 py-3 font-medium text-right">
                        กำไร/ขาดทุน (เดิม)
                      </th>
                      <th className="px-5 py-3 font-medium text-right">อัตรา FX</th>
                      <th className="px-5 py-3 font-medium text-right">
                        กำไร/ขาดทุน (บาท)
                      </th>
                      <th className="px-5 py-3 font-medium">สถานะ</th>
                      <th className="px-5 py-3 font-medium">เหตุผล</th>
                    </tr>
                  </thead>
                  <tbody>
                    {taxPhase.data.transactions.map((t) => {
                      const status = taxStatusLabel(t);
                      return (
                        <tr
                          key={t.transactionId}
                          className="border-b border-gray-50 last:border-0 align-top"
                        >
                          <td className="px-5 py-3 text-gray-500 whitespace-nowrap">
                            {t.transactionDate ?? "-"}
                          </td>
                          <td className="px-5 py-3">
                            <p className="text-gray-800 font-medium">
                              {t.symbol ?? "-"}
                            </p>
                            <p className="text-[11px] text-gray-400">
                              {t.currency ?? "-"}
                            </p>
                          </td>
                          <td className="px-5 py-3">
                            <span
                              className={`text-xs font-medium ${
                                t.side === "BUY"
                                  ? "text-blue-600"
                                  : t.side === "SELL"
                                    ? "text-red-600"
                                    : "text-gray-400"
                              }`}
                            >
                              {t.side ?? "-"}
                            </span>
                          </td>
                          <td className="px-5 py-3 text-gray-700 text-right whitespace-nowrap">
                            {t.quantity ?? "-"}
                          </td>
                          <td className="px-5 py-3 text-gray-700 text-right whitespace-nowrap">
                            {t.unitPrice ?? "-"}
                          </td>
                          <td className="px-5 py-3 text-gray-700 text-right whitespace-nowrap">
                            {t.grossAmount ?? "-"}
                          </td>
                          <td className="px-5 py-3 text-gray-700 text-right whitespace-nowrap">
                            {t.fees ?? "-"}
                          </td>
                          <td className="px-5 py-3 text-gray-700 text-right whitespace-nowrap">
                            {t.costBasis ?? "-"}
                          </td>
                          <td className="px-5 py-3 text-gray-700 text-right whitespace-nowrap">
                            {t.realizedGainLoss ?? "-"}
                          </td>
                          <td className="px-5 py-3 text-gray-500 text-right whitespace-nowrap">
                            {t.fxRateEffective ?? t.fxRateStatement ?? "-"}
                          </td>
                          <td
                            className={`px-5 py-3 text-right font-medium whitespace-nowrap ${
                              t.realizedGainLossThb != null
                                ? parseFloat(t.realizedGainLossThb) >= 0
                                  ? "text-emerald-600"
                                  : "text-red-500"
                                : "text-gray-300"
                            }`}
                          >
                            {t.realizedGainLossThb != null
                              ? `฿${t.realizedGainLossThb}`
                              : "-"}
                          </td>
                          <td className="px-5 py-3">
                            <span
                              className={`text-xs font-medium ${status.cls}`}
                            >
                              {status.text}
                            </span>
                          </td>
                          <td className="px-5 py-3 text-xs text-gray-400 leading-relaxed max-w-[260px]">
                            {t.status === "computable"
                              ? `กำไร/ขาดทุนรับรู้: ฿${t.realizedGainLossThb} · ฐานภาษี: ฿${t.taxableAmountThb}`
                              : t.classification === "non-computable"
                                ? taxReasonLabel(t)
                                : taxReasonLabel(t)}
                            {t.classification === "not-applicable" && (
                              <span
                                className="block text-[10px] text-gray-300"
                                title={t.reason}
                              >
                                (รายการกระแสเงินสด)
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <p className="px-5 py-3 text-xs text-gray-400">
              คำนวณกำไร/ขาดทุนรับรู้จากรายการขายหุ้น (SELL) ที่มีต้นทุนเฉลี่ยครบถ้วนเท่านั้น
              ซื้อหุ้น (BUY) เป็นรายการสะสมต้นทุน เงินฝาก/ถอน ค่าธรรมเนียม หรือรายการอื่น
              ที่มิใช่กำไรจากการขายหุ้นถูกจัดเป็น "ไม่ใช่รายการกำไรที่ต้องคำนวณ"
              และรายการที่คำนวณไม่ได้จะแสดงสถานะ "ยังไม่สามารถคำนวณ" อย่างชัดเจน
            </p>
          </>
        )}
      </div>

      {/* AI insight summary */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-blue-800" />
              <h2 className="text-sm font-semibold text-gray-800">
                สรุปกิจกรรมจาก CI Insight
              </h2>
            </div>
            {insightLoading ? (
              <span className="flex items-center gap-1 text-xs text-gray-400">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> กำลังวิเคราะห์...
              </span>
            ) : insight?.available && insight.result ? (
              <span className="text-xs text-emerald-600 font-medium">
                วิเคราะห์สำเร็จ
              </span>
            ) : null}
          </div>

          {insightLoading ? (
            <div className="px-5 py-12 text-center">
              <Loader2 className="w-8 h-8 text-gray-300 mx-auto mb-3 animate-spin" />
              <p className="text-sm font-medium text-gray-600">กำลังวิเคราะห์กิจกรรม</p>
            </div>
          ) : !insight ? (
            <div className="px-5 py-12 text-center">
              <Sparkles className="w-8 h-8 text-gray-300 mx-auto mb-3" />
              <p className="text-sm font-medium text-gray-600">
                สรุปกิจกรรมพร้อมใช้งานหลังนำเข้า Statement
              </p>
            </div>
          ) : !insight.available || !insight.result ? (
            <div className="px-5 py-10 text-center">
              <AlertTriangle className="w-8 h-8 text-amber-400 mx-auto mb-3" />
              <p className="text-sm font-medium text-gray-700">
                การวิเคราะห์ด้วย AI ไม่พร้อมใช้งาน
              </p>
              <p className="text-xs text-gray-400 mt-1">
                {insight.code === "GEMINI_NOT_CONFIGURED"
                  ? "ยังไม่ได้ตั้งค่า Gemini API"
                  : insight.code === "NO_TRANSACTIONS"
                  ? "ยังไม่มีธุรกรรมที่จะวิเคราะห์"
                  : `รหัส: ${insight.code}`}
              </p>
              {(insight.errors ?? []).map((e) => (
                <p key={e} className="text-xs text-gray-400 mt-1">
                  {e}
                </p>
              ))}
            </div>
          ) : (
            <div className="px-5 py-4 space-y-4">
              <p className="text-sm text-gray-700 leading-relaxed">
                {insight.result.summary}
              </p>
              {insight.aggregates && (
                <p className="text-xs text-gray-400">
                  วิเคราะห์จาก {insight.aggregates.transactionCount} รายการ ·{" "}
                  {insight.aggregates.currencies.join(", ")} · วันที่{" "}
                  {insight.aggregates.minDate} ถึง {insight.aggregates.maxDate}
                </p>
              )}
              {insight.result.patterns.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-gray-500 mb-1">รูปแบบที่พบ</p>
                  {insight.result.patterns.map((p, i) => (
                    <p key={i} className="text-xs text-gray-600 leading-relaxed">• {p}</p>
                  ))}
                </div>
              )}
              {insight.result.dataQualityNotes.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-gray-500 mb-1">คุณภาพข้อมูล</p>
                  {insight.result.dataQualityNotes.map((n, i) => (
                    <p key={i} className="text-xs text-gray-600 leading-relaxed">• {n}</p>
                  ))}
                </div>
              )}
              {insight.result.taxReadinessNotes.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-amber-600 mb-1">ความพร้อมคำนวณภาษี</p>
                  {insight.result.taxReadinessNotes.map((n, i) => (
                    <p key={i} className="text-xs text-amber-700 leading-relaxed">• {n}</p>
                  ))}
                </div>
              )}
              <p className="text-xs text-gray-400 pt-1 border-t border-gray-50">
                ข้อมูลนี้เป็นการวิเคราะห์เชิงโครงสร้างโดย Gemini เท่านั้น
                ไม่ใช่การคำนวณภาษีหรือคำแนะนำการลงทุน
              </p>
            </div>
          )}
        </div>
        <PdfStatementUploader
          onImport={onImport}
          onDocumentSaved={onDocumentSaved}
          onGeminiResult={handleGeminiResult}
        />
      </div>
    </div>
  );
}
