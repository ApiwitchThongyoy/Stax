import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  FolderOpen,
  Loader2,
  PieChart,
  RefreshCw,
  UploadCloud,
  X,
} from "lucide-react";
import { useAuth } from "../../lib/auth";

const MAX_PDF_SIZE_BYTES = 20 * 1024 * 1024;

type Phase =
  | "idle"
  | "validating"
  | "storing"
  | "extracting"
  | "parsing"
  | "computing"
  | "posting"
  | "reviewing"
  | "review"
  | "done"
  | "error";

const STEPS: { id: Phase; label: string }[] = [
  { id: "validating", label: "ตรวจสอบไฟล์" },
  { id: "storing", label: "เก็บเอกสาร" },
  { id: "extracting", label: "สกัดเนื้อหา PDF" },
  { id: "parsing", label: "ถอดรหัสธุรกรรม" },
  { id: "computing", label: "คำนวณต้นทุน/กำไร" },
  { id: "posting", label: "อัปเดตบัญชีแยกประเภท" },
  { id: "done", label: "เสร็จสิ้น" },
];

const STEP_ORDER: Phase[] = [
  "validating",
  "storing",
  "extracting",
  "parsing",
  "computing",
  "posting",
];

interface UploadStats {
  buyCount: number;
  sellCount: number;
  cashCount: number;
  computableSellCount: number;
  statementFxCount: number;
  fxRates?: Record<string, string>;
}

interface UploadResult {
  documentId: string;
  fileName: string;
  extracted: number;
  saved: number;
  rejected?: unknown[];
  rebuilt?: boolean;
  duplicates?: boolean;
  duplicate?: boolean;
  code?: string;
  unsupported?: boolean;
  duplicateDecision?: "fresh" | "rebuilt" | "duplicate" | "unsupported";
  stats?: UploadStats;
  rows?: PreviewTransactionRow[];
  posting?: {
    posted?: number;
    entryNumbers?: string[];
    skippedRows?: number;
    skippedWrite?: number;
  };
}

/** Server-side row shape returned by POST /api/v1/statements/preview. */
interface PreviewTransactionRow {
  transactionId: string;
  transactionDate: string;
  amountForeign: string;
  currency: string;
  amountThb: string;
  type: string;
  category: string;
  section: string;
  symbol: string | null;
  side: "BUY" | "SELL" | null;
  quantity: string | null;
  unitPrice: string | null;
  grossAmount: string | null;
  fees: string | null;
  netAmount: string | null;
  proceeds: string | null;
  costBasis: string | null;
  realizedGainLoss: string | null;
  realizedGainLossThb: string | null;
  fxRateStatement: string | null;
  fxRateEffective: string | null;
  exchange: string | null;
}

interface PreviewData {
  preview?: boolean;
  fileName?: string;
  documentId?: string | null;
  duplicate?: boolean;
  code?: string;
  message?: string;
  existingDocumentId?: string | null;
  duplicateDecision?: "fresh" | "rebuilt" | "unsupported";
  extracted?: number;
  rows?: PreviewTransactionRow[];
  rejected?: string[];
  stats?: UploadStats;
}

function stepIndex(phase: Phase): number {
  if (phase === "idle") return -1;
  if (phase === "done") return STEPS.length - 1;
  if (phase === "error") return STEPS.length - 1;
  const idx = STEP_ORDER.indexOf(phase);
  return idx === -1 ? 0 : idx;
}

export default function StatementUploadPage({
  onNavigateToArchive,
  onNavigateToOverview,
  onImportSuccess,
}: {
  onNavigateToArchive?: () => void;
  onNavigateToOverview?: () => void;
  onImportSuccess?: () => void;
}) {
  const { user } = useAuth();
  const accessToken = user?.accessToken ?? null;

  const [phase, setPhase] = useState<Phase>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [duplicateModal, setDuplicateModal] = useState<{
    open: boolean;
    fileName: string;
  }>({ open: false, fileName: "" });
  const timersRef = useRef<number[]>([]);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Unmount ระหว่างอนิเมชั่น: ยกเลิก timers ที่เหลือ (ผลลัพธ์บน server
      // ได้ commit แล้วจริง; หน้าโดน destroy ไม่ได้ทำให้ข้อมูลหาย)
      for (const t of timersRef.current) window.clearTimeout(t);
      timersRef.current = [];
    };
  }, []);

  const settle = (delay: number, fn: () => void) => {
    const t = window.setTimeout(() => {
      if (mountedRef.current) fn();
    }, delay);
    timersRef.current.push(t);
  };

  const advanceThrough = useCallback(
    (done: () => void) => {
      const duration = 700;
      settle(duration, () => setPhase("storing"));
      settle(duration * 2, () => setPhase("extracting"));
      settle(duration * 3, () => setPhase("parsing"));
      settle(duration * 4, () => setPhase("computing"));
      settle(duration * 5, () => setPhase("posting"));
      settle(duration * 6, done);
    },
    [settle]
  );

  const validateLocal = (f: File): string | null => {
    if (!f.name.toLowerCase().endsWith(".pdf")) {
      return 'รองรับเฉพาะไฟล์ ".pdf" เท่านั้น';
    }
    if (f.size <= 0 || f.size > MAX_PDF_SIZE_BYTES) {
      return "ไฟล์มีขนาดเกิน 20MB (หรือว่างเปล่า)";
    }
    return null;
  };

  const upload = useCallback(
    async (f: File) => {
      if (!accessToken) {
        setPhase("error");
        setError("ยังไม่มีเซสชันผู้ใช้ กรุณาเข้าสู่ระบบอีกครั้ง");
        return;
      }

      const invalid = validateLocal(f);
      if (invalid) {
        setPhase("error");
        setError(invalid);
        return;
      }

      setPhase("validating");
      setResult(null);
      setError(null);

      // (0) ยืนยัน magic bytes %PDF- เหมือนฝั่ง server (ไม่เชื่อเฉพาะ MIME header)
      const head = new Uint8Array(await f.slice(0, 5).arrayBuffer());
      const magic = Array.from(head)
        .map((b) => String.fromCharCode(b))
        .join("");
      if (magic !== "%PDF-") {
        setPhase("error");
        setError("ไฟล์นี้ไม่ใช่ PDF ตามลายเซ็นภายใน (magic bytes)");
        return;
      }

      // Client-side state machine (Option A): ลำดับขั้นตอนเป็นอนิเมชั่น
      // แสดงความคืบหน้าเท่านั้น — ค่าจริงทั้งหมดมาจาก response ของ POST
      // /api/v1/statements/upload ซึ่งยัง atomic อยู่ฝั่ง backend
      // เหมือนเดิม (ไม่เปลี่ยน contract การอัปโหลด)
      let uploadPromise: Promise<void>;
      let importIsDuplicate = false;
      let lastSaved = 0;
      try {
        const formData = new FormData();
        formData.append("file", f, f.name);
        uploadPromise = (async () => {
          const res = await fetch("/api/v1/statements/upload", {
            method: "POST",
            headers: { Authorization: `Bearer ${accessToken}` },
            body: formData,
          });
          let body: { success?: boolean; data?: UploadResult; message?: string };
          try {
            body = await res.json();
          } catch {
            body = {};
          }
          if (!res.ok || body.success !== true || !body.data) {
            throw new Error(body.message || "อัปโหลดไม่สำเร็จ");
          }
          if (body.data.duplicate === true || body.data.duplicates === true) {
            // ไฟล์ซ้ำ: ไม่นำเข้า ไม่โชว์หน้า "ผลการนำเข้า" และไม่เปิดให้
            // re-upload — หยุด animation, กลับหน้า dropzone (idle) แล้ว
            // แจ้งเตือนซ้ำตรงกลางจอ (import ต้องไม่ไปต่อ)
            importIsDuplicate = true;
            for (const t of timersRef.current) window.clearTimeout(t);
            timersRef.current = [];
            if (mountedRef.current) {
              setResult(null);
              setPhase("idle");
            }
            setDuplicateModal({ open: true, fileName: f.name });
          } else if (
            body.data.saved === 0 ||
            body.data.unsupported === true ||
            body.data.duplicateDecision === "unsupported"
          ) {
            // "สำเร็จ" แต่ไม่มีรายการใดถูกบันทึก (หรือไฟล์ถอดรหัสไม่ได้):
            // ต้องไม่แสดงเป็นหน้านำเข้าสำเร็จ — ยกเป็น error ชัดเจนแทน
            throw new Error(
              body.data.unsupported === true ||
                body.data.duplicateDecision === "unsupported"
                ? "ไฟล์นี้ยังถอดรหัสธุรกรรมไม่ได้ (ไม่พบรายการที่ระบบรู้จัก) กรุณาตรวจสอบไฟล์อีกครั้ง"
                : "การนำเข้าไม่มีรายการใดถูกบันทึก กรุณาลองอีกครั้ง"
            );
          } else {
            lastSaved = body.data.saved;
            setResult(body.data);
          }
        })();
      } catch (networkError) {
        setPhase("error");
        setError(
          networkError instanceof Error
            ? networkError.message
            : "เกิดข้อผิดพลาดขณะติดต่อเซิร์ฟเวอร์"
        );
        return;
      }

      // เริ่มลำดับอนิเมชั่นทันที; สลับไป "เสร็จสิ้น" เมื่อ server ตอบจริง
      // (เว้นแต่เป็นการซ้ำ — import ไม่ไปต่อ แล้วจะกลับ idle แทน)
      advanceThrough(() => {
        if (mountedRef.current) setPhase("done");
      });
      try {
        await uploadPromise;
      } catch (err) {
        if (!mountedRef.current) return;
        setPhase("error");
        setError(
          err instanceof Error ? err.message : "เกิดข้อผิดพลาดระหว่างการอัปโหลด"
        );
        return;
      }
      if (mountedRef.current && !importIsDuplicate) {
        setPhase("done");
        // Genuine import success: let the Dashboard refresh server data so the
        // home widgets (ledger / holdings / tax) reflect the new rows.
        if (lastSaved > 0 && onImportSuccess) onImportSuccess();
      }
    },
    [accessToken, advanceThrough, onImportSuccess]
  );

  // ขั้นพรีวิวก่อน import: ถอดรหัสธุรกรรมจากไฟล์แบบ read-only (POST
  // /api/v1/statements/preview) — server extract + parse + คำนวณในหน่วยความจำ
  // เท่านั้น ไม่เขียนฐานข้อมูล/ไม่เก็บไฟล์/ไม่โพสต์บัญชี ค่าทั้งหมดที่แสดง
  // (รวมตารางรายละเอียด) มาจาก response โดยตรง
  const previewFile = async (f: File) => {
    if (!accessToken) {
      setPhase("error");
      setError("ยังไม่มีเซสชันผู้ใช้ กรุณาเข้าสู่ระบบอีกครั้ง");
      return;
    }

    const invalid = validateLocal(f);
    if (invalid) {
      setPhase("error");
      setError(invalid);
      return;
    }

    setPhase("reviewing");
    setFile(f);
    setResult(null);
    setPreview(null);
    setError(null);

    // (0) ยืนยัน magic bytes %PDF- เหมือนฝั่ง server (ไม่เชื่อเฉพาะ MIME header)
    try {
      const head = new Uint8Array(await f.slice(0, 5).arrayBuffer());
      const magic = Array.from(head)
        .map((b) => String.fromCharCode(b))
        .join("");
      if (magic !== "%PDF-") {
        setPhase("error");
        setError("ไฟล์นี้ไม่ใช่ PDF ตามลายเซ็นภายใน (magic bytes)");
        return;
      }
    } catch {
      setPhase("error");
      setError("ไม่สามารถอ่านไฟล์นี้ได้ กรุณาลองอีกครั้ง");
      return;
    }

    try {
      const formData = new FormData();
      formData.append("file", f, f.name);
      const res = await fetch("/api/v1/statements/preview", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
        body: formData,
      });
      let body: { success?: boolean; data?: PreviewData; message?: string };
      try {
        body = await res.json();
      } catch {
        body = {};
      }
      if (!res.ok || body.success !== true || !body.data) {
        setPhase("error");
        setError(body.message || "ไม่สามารถวิเคราะห์ไฟล์ได้ กรุณาลองใหม่");
        return;
      }
      if (body.data.duplicate === true) {
        // ไฟล์ซ้ำ: ไม่แสดงหน้าตรวจสอบ ไม่นำเข้าเด็ดขาด — กลับ dropzone แล้ว
        // แจ้งเตือนซ้ำตรงกลางจอ (import ต้องไม่ไปต่อ)
        setPhase("idle");
        setDuplicateModal({ open: true, fileName: f.name });
        return;
      }
      if (!body.data.rows || body.data.rows.length === 0) {
        setPhase("error");
        setError(
          "ไม่พบรายการที่ระบบรู้จักในไฟล์นี้ อาจเป็นเพราะรูปแบบเอกสารไม่ตรงกับที่ระบบรองรับ"
        );
        return;
      }
      setPreview(body.data);
      setPhase("review");
    } catch (networkError) {
      setPhase("error");
      setError(
        networkError instanceof Error
          ? networkError.message
          : "เกิดข้อผิดพลาดขณะติดต่อเซิร์ฟเวอร์"
      );
    }
  };

  // ปุ่ม OK: ยืนยันให้ import จริง (POST /api/v1/statements/upload แบบเดิม —
  // INSERT + cost basis + backfill + postings ฝั่ง server) ข้อมูลอาจถูกเขียนแล้ว
  // เฉพาะจุดนี้เท่านั้น
  const handlePreviewConfirm = () => {
    if (!file) return;
    void upload(file);
  };

  const onFiles = (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    setFile(f);
    void previewFile(f);
  };

  const reset = () => {
    for (const t of timersRef.current) window.clearTimeout(t);
    timersRef.current = [];
    setFile(null);
    setResult(null);
    setPreview(null);
    setError(null);
    setPhase("idle");
  };

  const isRunning =
    phase === "validating" ||
    phase === "storing" ||
    phase === "extracting" ||
    phase === "parsing" ||
    phase === "computing" ||
    phase === "posting";

  const progress =
    phase === "idle"
      ? 0
      : phase === "done" || phase === "error"
        ? 100
        : Math.round(
            ((STEP_ORDER.indexOf(phase) + 1) / STEPS.length) * 100
          );

  const decisionLabel =
    result?.duplicate === true
      ? "ไฟล์นี้ถูกนำเข้าแล้ว (สำเนาซ้ำ ระบบข้ามการทำงานซ้ำ)"
      : result?.duplicateDecision === "rebuilt"
        ? "นำเข้าใหม่ (ไฟล์ซ้ำเดิม + ข้อมูลถูกลบไปก่อนหน้า)"
        : result?.duplicateDecision === "duplicate"
          ? "ไฟล์นี้ถูกนำเข้าแล้ว (สำเนาซ้ำ ระบบข้ามการทำงานซ้ำ)"
          : result?.duplicateDecision === "unsupported"
            ? "ไฟล์นี้ยังถอดรหัสธุรกรรมไม่ได้"
            : result?.rebuilt
              ? "สร้างรายการใหม่อีกครั้ง"
              : "นำเข้าสำเร็จ";

  return (
    <div className="space-y-6">
      {/* Banner */}
      <div className="bg-linear-to-br from-blue-900 to-blue-950 rounded-2xl px-6 py-5 text-white">
        <p className="text-xs text-blue-300 mb-1">อัปโหลด Statement</p>
        <h1 className="text-xl font-semibold mb-1.5">นำเข้าเอกสาร Statement</h1>
        <p className="text-sm text-blue-200">
          ลากไฟล์ PDF statement มาที่ช่องด้านล่าง ระบบจะสกัดธุรกรรม คำนวณต้นทุน
          และอัปเดตบัญชีแยกประเภทให้อัตโนมัติ
        </p>
      </div>

      {phase === "idle" ? (
        <div className="space-y-4">
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            onFiles(e.dataTransfer.files);
          }}
          className={`flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed bg-white px-6 py-16 text-center cursor-pointer transition ${
            dragOver
              ? "border-blue-900 bg-blue-50/50"
              : "border-gray-200 hover:border-blue-300 hover:bg-gray-50"
          }`}
        >
          <input
            type="file"
            accept="application/pdf,.pdf"
            className="hidden"
            onChange={(e) => onFiles(e.target.files)}
          />
          <div className="w-14 h-14 rounded-2xl bg-blue-50 flex items-center justify-center">
            <UploadCloud className="w-7 h-7 text-blue-900" />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-800">
              ลากวางไฟล์ PDF ที่นี่ หรือคลิกเพื่อเลือกไฟล์
            </p>
            <p className="text-xs text-gray-400 mt-1">
              รองรับไฟล์ .pdf สูงสุด 20MB ไฟล์ซ้ำจะถูกตรวจสอบอัตโนมัติ
            </p>
          </div>
        </label>
        </div>
      ) : phase === "done" ? (
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100">
            <CheckCircle2 className="w-4 h-4 text-emerald-500" />
            <h2 className="text-sm font-semibold text-gray-800">
              ผลการนำเข้า
            </h2>
          </div>
          <div className="px-5 py-6 space-y-4">
            <div className="flex items-start gap-3">
              <FileText className="w-5 h-5 text-blue-900 mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="text-sm font-semibold text-gray-800 truncate">
                  {file?.name ?? result?.fileName}
                </p>
                <p className="text-xs text-gray-500 mt-0.5">{decisionLabel}</p>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-gray-50 rounded-xl p-3 text-center">
                <p className="text-lg font-bold text-gray-800">
                  {result?.extracted ?? 0}
                </p>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  รายการที่พบ
                </p>
              </div>
              <div className="bg-emerald-50 rounded-xl p-3 text-center">
                <p className="text-lg font-bold text-emerald-600">
                  {result?.saved ?? 0}
                </p>
                <p className="text-[11px] text-emerald-700/80 mt-0.5">
                  บันทึกแล้ว
                </p>
              </div>
              <div className="bg-blue-50 rounded-xl p-3 text-center">
                <p className="text-lg font-bold text-blue-900">
                  {result?.stats?.buyCount ?? 0}
                </p>
                <p className="text-[11px] text-blue-800/80 mt-0.5">ซื้อ (BUY)</p>
              </div>
              <div className="bg-red-50 rounded-xl p-3 text-center">
                <p className="text-lg font-bold text-red-600">
                  {result?.stats?.sellCount ?? 0}
                </p>
                <p className="text-[11px] text-red-700/80 mt-0.5">
                  ขาย (SELL)
                </p>
              </div>
              <div className="bg-gray-50 rounded-xl p-3 text-center">
                <p className="text-lg font-bold text-gray-800">
                  {result?.stats?.cashCount ?? 0}
                </p>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  เงินสด (CASH)
                </p>
              </div>
              <div className="bg-gray-50 rounded-xl p-3 text-center">
                <p className="text-lg font-bold text-gray-800">
                  {result?.stats?.computableSellCount ?? 0}
                </p>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  SELL คำนวณกำไรได้
                </p>
              </div>
              <div className="bg-gray-50 rounded-xl p-3 text-center">
                <p className="text-lg font-bold text-gray-800">
                  {result?.stats?.statementFxCount ?? 0}
                </p>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  อัตราจาก Statement
                </p>
              </div>
              <div className="bg-gray-50 rounded-xl p-3 text-center">
                <p className="text-lg font-bold text-gray-800">
                  {result?.posting?.posted ?? "-"}
                </p>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  รายการโพสต์ในบัญชี
                </p>
              </div>
            </div>

            {(result?.posting?.skippedRows ?? 0) > 0 && (
              <p className="text-xs text-gray-500">
                รายการที่ข้ามการโพสต์ (สกุลเงินไม่ตรงกับบัญชี/รูปแบบไม่รองรับ):{" "}
                {result?.posting?.skippedRows}
              </p>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-gray-100">
              <button
                type="button"
                onClick={() => void upload(file!)}
                className="inline-flex items-center gap-1.5 bg-blue-900 hover:bg-blue-950 text-white text-xs font-medium px-4 py-2 rounded-lg transition"
              >
                <UploadCloud className="w-3.5 h-3.5" />
                อัปโหลดไฟล์นี้อีกครั้ง
              </button>
              {onNavigateToArchive && (
                <button
                  type="button"
                  onClick={onNavigateToArchive}
                  className="inline-flex items-center gap-1.5 bg-white border border-gray-200 hover:bg-gray-50 text-gray-600 text-xs font-medium px-4 py-2 rounded-lg transition"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  ไปดูคลัง Statement
                </button>
              )}
              {onNavigateToOverview && (
                <button
                  type="button"
                  onClick={onNavigateToOverview}
                  className="inline-flex items-center gap-1.5 bg-white border border-gray-200 hover:bg-gray-50 text-gray-600 text-xs font-medium px-4 py-2 rounded-lg transition"
                >
                  <PieChart className="w-3.5 h-3.5" />
                  ไปดูภาพรวมการเงิน
                </button>
              )}
              <button
                type="button"
                onClick={reset}
                className="inline-flex items-center gap-1.5 bg-white border border-gray-200 hover:bg-gray-50 text-gray-600 text-xs font-medium px-4 py-2 rounded-lg transition"
              >
                <UploadCloud className="w-3.5 h-3.5" />
                อัปโหลดไฟล์อื่น
              </button>
            </div>
          </div>
        </div>
      ) : phase === "error" ? (
        <div className="bg-white rounded-xl border border-gray-100 px-6 py-10 text-center">
          <AlertTriangle className="w-10 h-10 text-amber-500 mx-auto mb-3" />
          <p className="text-sm font-medium text-gray-800">
            การอัปโหลดไม่สำเร็จ
          </p>
          <p className="text-xs text-gray-500 mt-1">{error}</p>
          <div className="flex items-center justify-center gap-2 mt-5">
            <button
              type="button"
              onClick={reset}
              className="inline-flex items-center gap-1.5 bg-blue-900 hover:bg-blue-950 text-white text-xs font-medium px-4 py-2 rounded-lg transition"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              ลองใหม่
            </button>
            {onNavigateToArchive && (
              <button
                type="button"
                onClick={onNavigateToArchive}
                className="inline-flex items-center gap-1.5 bg-white border border-gray-200 hover:bg-gray-50 text-gray-600 text-xs font-medium px-4 py-2 rounded-lg transition"
              >
                <FolderOpen className="w-3.5 h-3.5" />
                ไปดูคลัง Statement
              </button>
            )}
          </div>
        </div>
      ) : phase === "reviewing" ? (
        /* พรีวิวก่อนนำเข้า: รอผลจาก POST /api/v1/statements/preview (read-only) */
        <div className="bg-white rounded-xl border border-gray-100 px-6 py-10">
          <div className="text-center max-w-md mx-auto">
            <div className="relative w-16 h-16 mx-auto mb-4">
              <div className="absolute inset-0 rounded-2xl bg-blue-50 flex items-center justify-center">
                <Loader2 className="w-7 h-7 text-blue-900 animate-spin" />
              </div>
            </div>
            <p className="text-sm font-semibold text-gray-800">
              กำลังอ่านไฟล์{" "}
              <span className="font-mono">{file?.name}</span>...
            </p>
            <p className="text-xs text-gray-400 mt-1">
              ระบบกำลังสกัดและถอดรหัสธุรกรรม โดยยังไม่บันทึกลงฐานข้อมูล
            </p>
          </div>
        </div>
      ) : phase === "review" ? (
        /* หน้าตรวจสอบก่อนนำเข้า: รายละเอียดจากเซิร์ฟเวอร์ + ปุ่ม OK เพื่อนำเข้าจริง */
        <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
          <div className="flex items-center gap-2 px-5 py-4 border-b border-gray-100">
            <FileText className="w-4 h-4 text-blue-900 shrink-0" />
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-gray-800">
                ตรวจสอบเอกสารก่อนนำเข้า
              </h2>
              <p className="text-xs text-gray-400 mt-0.5 truncate">
                พบ {preview?.rows?.length ?? 0} รายการ จาก{" "}
                {preview?.fileName ?? file?.name}
              </p>
            </div>
          </div>

          <div className="px-5 py-6 space-y-4">
            {preview?.duplicateDecision === "rebuilt" && (
              <p className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 rounded-lg px-3 py-2.5">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                ข้อมูลเก่าของ Statement นี้ถูกลบไปก่อนหน้า ระบบจะสร้างรายการใหม่
                ภายใต้เอกสารเดิมเมื่อกด OK
              </p>
            )}

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="bg-gray-50 rounded-xl p-3 text-center">
                <p className="text-lg font-bold text-gray-800">
                  {preview?.extracted ?? 0}
                </p>
                <p className="text-[11px] text-gray-500 mt-0.5">รายการที่พบ</p>
              </div>
              <div className="bg-blue-50 rounded-xl p-3 text-center">
                <p className="text-lg font-bold text-blue-900">
                  {preview?.rows?.length ?? 0}
                </p>
                <p className="text-[11px] text-blue-800/80 mt-0.5">จะนำเข้า</p>
              </div>
              <div className="bg-blue-50 rounded-xl p-3 text-center">
                <p className="text-lg font-bold text-blue-900">
                  {preview?.stats?.buyCount ?? 0}
                </p>
                <p className="text-[11px] text-blue-800/80 mt-0.5">ซื้อ (BUY)</p>
              </div>
              <div className="bg-red-50 rounded-xl p-3 text-center">
                <p className="text-lg font-bold text-red-600">
                  {preview?.stats?.sellCount ?? 0}
                </p>
                <p className="text-[11px] text-red-700/80 mt-0.5">ขาย (SELL)</p>
              </div>
              <div className="bg-gray-50 rounded-xl p-3 text-center">
                <p className="text-lg font-bold text-gray-800">
                  {preview?.stats?.cashCount ?? 0}
                </p>
                <p className="text-[11px] text-gray-500 mt-0.5">เงินสด (CASH)</p>
              </div>
              <div className="bg-gray-50 rounded-xl p-3 text-center">
                <p className="text-lg font-bold text-gray-800">
                  {preview?.stats?.computableSellCount ?? 0}
                </p>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  SELL คำนวณกำไรได้
                </p>
              </div>
              <div className="bg-gray-50 rounded-xl p-3 text-center">
                <p className="text-lg font-bold text-gray-800">
                  {preview?.stats?.statementFxCount ?? 0}
                </p>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  อัตราจาก Statement
                </p>
              </div>
            </div>

            <div className="border border-gray-100 rounded-lg overflow-x-auto">
              <table className="w-full text-xs whitespace-nowrap">
                <thead>
                  <tr className="bg-gray-50 text-left text-gray-500">
                    <th className="px-3 py-2 font-medium">วันที่</th>
                    <th className="px-3 py-2 font-medium">รายการ</th>
                    <th className="px-3 py-2 font-medium">ฝั่ง</th>
                    <th className="px-3 py-2 font-medium text-right">จำนวน</th>
                    <th className="px-3 py-2 font-medium text-right">
                      ราคา/หน่วย
                    </th>
                    <th className="px-3 py-2 font-medium text-right">
                      มูลค่ารวม
                    </th>
                    <th className="px-3 py-2 font-medium text-right">
                      ค่าธรรมเนียม
                    </th>
                    <th className="px-3 py-2 font-medium text-right">
                      เงินเข้า/ออก
                    </th>
                    <th className="px-3 py-2 font-medium text-right">
                      อัตรา FX
                    </th>
                    <th className="px-3 py-2 font-medium text-right">
                      กำไร/ขาดทุน (THB)
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-50">
                  {(preview?.rows ?? []).map((r) => (
                    <tr key={r.transactionId} className="hover:bg-gray-50/60">
                      <td className="px-3 py-2 text-gray-500">
                        {r.transactionDate}
                      </td>
                      <td className="px-3 py-2 text-gray-800 font-medium">
                        {r.symbol ? `${r.symbol} · ${r.section}` : r.section}
                      </td>
                      <td className="px-3 py-2">
                        {r.side === "BUY" ? (
                          <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-50 text-emerald-600">
                            BUY
                          </span>
                        ) : r.side === "SELL" ? (
                          <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-semibold bg-red-50 text-red-600">
                            SELL
                          </span>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-700">
                        {r.quantity ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-700">
                        {r.unitPrice ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-700">
                        {r.grossAmount ?? "—"}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-700">
                        {r.fees ?? "—"}
                      </td>
                      <td
                        className={`px-3 py-2 text-right font-medium ${
                          r.type === "CASH_OUT"
                            ? "text-red-500"
                            : "text-emerald-600"
                        }`}
                      >
                        {r.type === "CASH_OUT" ? "-" : "+"}
                        {Number(r.amountForeign).toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}{" "}
                        {r.currency}
                      </td>
                      <td className="px-3 py-2 text-right text-gray-700">
                        {r.fxRateEffective ?? "—"}
                      </td>
                      <td
                        className={`px-3 py-2 text-right font-medium ${
                          r.realizedGainLossThb != null &&
                          Number(r.realizedGainLossThb) >= 0
                            ? "text-emerald-600"
                            : "text-red-500"
                        }`}
                      >
                        {r.realizedGainLossThb != null
                          ? Number(r.realizedGainLossThb).toLocaleString(
                              undefined,
                              {
                                minimumFractionDigits: 2,
                                maximumFractionDigits: 2,
                              }
                            )
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-gray-100">
              <button
                type="button"
                onClick={reset}
                className="inline-flex items-center gap-1.5 bg-white border border-gray-200 hover:bg-gray-50 text-gray-600 text-xs font-medium px-4 py-2 rounded-lg transition"
              >
                <X className="w-3.5 h-3.5" />
                ยกเลิก
              </button>
              <button
                type="button"
                onClick={handlePreviewConfirm}
                className="inline-flex items-center gap-1.5 bg-blue-900 hover:bg-blue-950 text-white text-xs font-medium px-4 py-2 rounded-lg transition"
              >
                <CheckCircle2 className="w-3.5 h-3.5" />
                OK — นำเข้า {preview?.rows?.length ?? 0} รายการ
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* Scanning animation (Option A client state machine) */
        <div className="bg-white rounded-xl border border-gray-100 px-6 py-10">
          <div className="text-center max-w-md mx-auto">
            <div className="relative w-16 h-16 mx-auto mb-4">
              <div className="absolute inset-0 rounded-2xl bg-blue-50 flex items-center justify-center">
                <Loader2 className="w-7 h-7 text-blue-900 animate-spin" />
              </div>
            </div>
            <p className="text-sm font-semibold text-gray-800">
              กำลังประมวลผล <span className="font-mono">{file?.name}</span>
            </p>
            <p className="text-xs text-gray-400 mt-1">
              อย่าปิดหน้านี้ระหว่างการประมวลผล
            </p>
          </div>

          <div className="mt-6 mx-auto max-w-md">
            <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full bg-blue-900 transition-all duration-500"
                style={{ width: `${progress}%` }}
              />
            </div>
          </div>

          <ol className="mt-6 mx-auto max-w-md space-y-1">
            {STEPS.map((s, i) => {
              const current = STEP_ORDER.indexOf(s.id) === STEP_ORDER.indexOf(phase);
              const reached = i <= stepIndex(phase);
              return (
                <li key={s.id} className="flex items-center gap-3 py-2">
                  <span
                    className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 transition ${
                      current
                        ? "bg-blue-900 text-white animate-pulse"
                        : reached
                          ? "bg-emerald-50 text-emerald-500 border border-emerald-100"
                          : "bg-gray-50 text-gray-300 border border-gray-100"
                    }`}
                  >
                    {reached && !current && i !== STEPS.length - 1 ? (
                      <CheckCircle2 className="w-4 h-4" />
                    ) : current ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <span className="text-[10px] font-semibold">
                        {String(i + 1).padStart(2, "0")}
                      </span>
                    )}
                  </span>
                  <span
                    className={`text-sm ${
                      current
                        ? "text-gray-800 font-medium"
                        : reached
                          ? "text-gray-700"
                          : "text-gray-300"
                    }`}
                  >
                    {s.label}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {/* ----- Modal แจ้งเตือน Statement ซ้ำ (ปิดด้วย X หรือ OK เท่านั้น) ----- */}
      {duplicateModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/40 backdrop-blur-sm">
          <div className="w-full max-w-sm bg-white rounded-2xl shadow-xl overflow-hidden">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <h4 className="text-sm font-semibold text-gray-800">
                Statement ซ้ำ
              </h4>
              <button
                type="button"
                onClick={() => setDuplicateModal({ open: false, fileName: "" })}
                className="text-gray-400 hover:text-gray-600 transition p-1"
                aria-label="ปิดหน้าต่าง"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Body */}
            <div className="px-5 py-6">
              <div className="flex flex-col items-center text-center gap-3">
                <div className="w-12 h-12 rounded-full bg-amber-50 flex items-center justify-center">
                  <AlertTriangle className="w-6 h-6 text-amber-500" />
                </div>
                <p className="text-sm text-gray-700">
                  ไฟล์{" "}
                  <span className="font-medium text-gray-900">
                    &quot;{duplicateModal.fileName}&quot;
                  </span>{" "}
                  เคยถูกนำเข้าแล้ว จึงไม่มีการเพิ่มรายการซ้ำ
                </p>
              </div>
            </div>

            {/* Footer */}
            <div className="px-5 py-4 border-t border-gray-100 flex justify-end">
              <button
                type="button"
                onClick={() => setDuplicateModal({ open: false, fileName: "" })}
                className="bg-blue-900 hover:bg-blue-950 text-white text-sm font-medium px-6 py-2.5 rounded-lg transition"
              >
                OK
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}