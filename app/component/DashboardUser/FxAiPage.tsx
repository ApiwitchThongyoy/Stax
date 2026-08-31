import { useCallback, useEffect, useState } from "react";
import {
  TrendingUp,
  LineChart,
  WifiOff,
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
  status: "not-computable";
  reason: string;
}

interface TaxResponse {
  success: boolean;
  message?: string;
  data?: {
    computable: boolean;
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
      setTaxPhase({ phase: "success", data: { computable: false, reason: "ไม่มีธุรกรรม", transactions: [], totalTaxableAmountThb: null } });
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

  const statusCards: {
    key: string;
    title: string;
    message: string;
    detail: string;
    Icon: typeof WifiOff;
  }[] = [
    {
      key: "bot",
      title: "อัตราแลกเปลี่ยนเรียลไทม์",
      message: "ยังไม่ได้เชื่อมต่อ BOT API",
      detail:
        "อัตราแบบเรียลไทม์จะแสดงที่นี่เมื่อเชื่อมต่อ BOT API กับ backend แล้ว",
      Icon: WifiOff,
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
                <p className="text-sm font-semibold text-gray-800">
                  ฐานภาษีรวม: ฿{taxPhase.data.totalTaxableAmountThb}
                </p>
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
                      <th className="px-5 py-3 font-medium">สกุลเงิน</th>
                      <th className="px-5 py-3 font-medium text-right">
                        ยอดเงินสด (บาท)
                      </th>
                      <th className="px-5 py-3 font-medium">สถานะ</th>
                      <th className="px-5 py-3 font-medium">เหตุผล</th>
                    </tr>
                  </thead>
                  <tbody>
                    {taxPhase.data.transactions.map((t) => (
                      <tr
                        key={t.transactionId}
                        className="border-b border-gray-50 last:border-0"
                      >
                        <td className="px-5 py-3 text-gray-500 whitespace-nowrap">
                          {t.transactionDate ?? "-"}
                        </td>
                        <td className="px-5 py-3 text-gray-500">
                          {t.currency ?? "-"}
                        </td>
                        <td className="px-5 py-3 text-gray-800 font-medium text-right">
                          {t.transactionAmountThb}
                        </td>
                        <td className="px-5 py-3">
                          <span className="text-xs font-medium text-amber-600">
                            ยังไม่สามารถคำนวณภาษีรายการนี้ได้
                          </span>
                        </td>
                        <td className="px-5 py-3 text-xs text-gray-400 leading-relaxed max-w-[280px]">
                          {t.reason}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p className="px-5 py-3 text-xs text-gray-400">
              ระบบไม่ประดิษฐ์กำไร/ขาดทุนจากยอดเงินสดเข้า-ออก
              เนื่องจากข้อมูลต้นทุนยังไม่ครบถ้วน
            </p>
          </>
        )}
      </div>

      {/* Upload entry */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white rounded-xl border border-gray-100 p-5 flex items-center justify-center text-center">
          <div>
            <TrendingUp className="w-8 h-8 text-gray-300 mx-auto mb-3" />
            <p className="text-sm font-medium text-gray-600">
              การวิเคราะห์อัตราแลกเปลี่ยนด้วย AI ยังไม่พร้อมใช้งาน
            </p>
            <p className="text-xs text-gray-400 mt-1 max-w-sm mx-auto">
              ระบบจะวิเคราะห์แนวโน้มอัตราแลกเปลี่ยนและให้ข้อเสนอแนะอัตโนมัติ
              หลังเชื่อมต่อ BOT API
            </p>
          </div>
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
