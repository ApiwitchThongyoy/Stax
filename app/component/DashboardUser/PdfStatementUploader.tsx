import { useRef, useState, type DragEvent } from "react";
import { UploadCloud, Sparkles, FileWarning, CheckCircle2, X } from "lucide-react";
import { saveDocument } from "../../lib/Documentstorage";
import { useAuth } from "../../lib/auth";
import {
  parsePdfStatement,
  loadCostBasis,
  saveCostBasis,
  type ExtractedTransaction,
} from "../../lib/pdfStatementParser";

type Status = "idle" | "processing" | "error";

interface PdfStatementUploaderProps {
  onImport: (transactions: ExtractedTransaction[]) => void;
  onDocumentSaved?: () => void;
}

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 animate-pulse">
      <div className="w-4 h-4 rounded bg-gray-200 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <div className="h-3 bg-gray-200 rounded w-2/5" />
          <div className="h-3 bg-gray-200 rounded w-16" />
        </div>
        <div className="h-2.5 bg-gray-100 rounded w-1/3" />
      </div>
    </div>
  );
}

export default function PdfStatementUploader({ onImport, onDocumentSaved }: PdfStatementUploaderProps) {
  const [status, setStatus] = useState<Status>("idle");
  const [isDragActive, setIsDragActive] = useState(false);
  const [fileName, setFileName] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [extracted, setExtracted] = useState<ExtractedTransaction[]>([]);
  const [isReviewOpen, setIsReviewOpen] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const { user } = useAuth();
  const [serverStatus, setServerStatus] = useState<
    "idle" | "saving" | "saved" | "error"
  >("idle");
  const [serverMessage, setServerMessage] = useState("");

  const resetToIdle = () => {
    setStatus("idle");
    setFileName("");
    setErrorMessage("");
    setExtracted([]);
    setIsReviewOpen(false);
    setPendingFile(null);
    setServerStatus("idle");
    setServerMessage("");
  };

  const processFile = async (file: File) => {
    if (file.type !== "application/pdf") {
      setStatus("error");
      setErrorMessage("รองรับเฉพาะไฟล์ PDF เท่านั้น");
      return;
    }

    setFileName(file.name);
    setPendingFile(file);
    setStatus("processing");
    setErrorMessage("");

    try {
      const existingCostBasis = loadCostBasis();
      const { transactions, updatedCostBasis } = await parsePdfStatement(
        file,
        existingCostBasis
      );
      if (transactions.length === 0) {
        setStatus("error");
        setErrorMessage(
          "ไม่พบรายการที่รู้จักในไฟล์นี้ อาจเป็นเพราะรูปแบบเอกสารไม่ตรงกับที่ระบบรองรับ"
        );
        return;
      }
      // บันทึกต้นทุนเฉลี่ยสะสมล่าสุดไว้ ใช้ต่อตอน import ไฟล์เดือนถัดไป
      saveCostBasis(updatedCostBasis);
      setExtracted(transactions);
      setStatus("idle");
      setIsReviewOpen(true);
    } catch (err) {
      setStatus("error");
      setErrorMessage("ไม่สามารถอ่านไฟล์นี้ได้ กรุณาตรวจสอบว่าไฟล์ไม่เสียหาย");
    }
  };

  const handleDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setIsDragActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) processFile(file);
  };

  const toggleInclude = (id: string) => {
    setExtracted((prev) =>
      prev.map((t) => (t.id === id ? { ...t, included: !t.included } : t))
    );
  };

  const handleConfirmImport = () => {
    const selected = extracted.filter((t) => t.included);
    onImport(selected);

    // ส่งไฟล์ PDF ไปยังเซิร์ฟเวอร์เพื่อ extract/parse และ INSERT ลง Capital_Transactions
    if (pendingFile) {
      void uploadToServer(pendingFile);
    }

    // เก็บไฟล์ PDF ต้นฉบับไว้ใน IndexedDB ของเบราว์เซอร์ (ดูย้อนหลัง/ดาวน์โหลดได้ในเครื่องนี้)
    if (pendingFile) {
      saveDocument(pendingFile)
        .then(() => onDocumentSaved?.())
        .catch(() => {
          // การบันทึกไฟล์ล้มเหลวไม่ควรบล็อกการนำเข้าข้อมูลธุรกรรม จึงแค่เงียบไว้
        });
    }

    resetToIdle();
  };

  const uploadToServer = async (file: File) => {
    if (!user?.accessToken) {
      setServerStatus("error");
      setServerMessage("กรุณาเข้าสู่ระบบก่อนส่งข้อมูลเข้าสู่ระบบ");
      return;
    }

    setServerStatus("saving");
    setServerMessage("กำลังบันทึกข้อมูลลงฐานข้อมูล...");
    try {
      const body = new FormData();
      body.append("file", file, file.name);
      const response = await fetch("/api/v1/statements/upload", {
        method: "POST",
        headers: { Authorization: `Bearer ${user.accessToken}` },
        body,
      });

      const data = await response.json();
      if (!response.ok || !data.success) {
        setServerStatus("error");
        setServerMessage(data.message || "ไม่สามารถส่งข้อมูลได้ กรุณาลองใหม่");
        return;
      }

      const res = data.data;
      if (res.duplicates) {
        setServerStatus("saved");
        setServerMessage("เอกสารนี้เคยบันทึกแล้ว ไม่เพิ่มรายการซ้ำ");
      } else if (res.saved > 0) {
        setServerStatus("saved");
        setServerMessage(
          `บันทึกลงฐานข้อมูลแล้ว ${res.saved} รายการ (จากที่รู้จัก ${res.extracted} รายการ)`
        );
      } else if (res.unsupported) {
        setServerStatus("idle");
        setServerMessage(
          "ไม่พบรายการที่ระบบรู้จัก จึงไม่ได้บันทึกลงฐานข้อมูล (ไม่มีข้อมูลที่สร้างขึ้นเอง)"
        );
      } else {
        setServerStatus("saved");
        setServerMessage("ไม่มีรายการใหม่ที่บันทึก");
      }
    } catch {
      setServerStatus("error");
      setServerMessage("ไม่สามารถเชื่อมต่อเซิร์ฟเวอร์ได้ โปรดลองอีกครั้ง");
    }
  };

  const selectedCount = extracted.filter((t) => t.included).length;

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-5">
      <div className="flex items-center gap-1.5 mb-4">
        <Sparkles className="w-4 h-4 text-blue-800" />
        <h3 className="text-sm font-semibold text-gray-800">
          ระบบวิเคราะห์เอกสารอัจฉริยะ AI
        </h3>
      </div>

      {status === "processing" ? (
        // ----- Skeleton loader: โชว์โครงรายการปลอมกะพริบ ระหว่างรอประมวลผลไฟล์จริง -----
        <div>
          <div className="flex items-center gap-2 mb-3 px-1">
            <div className="w-3.5 h-3.5 border-2 border-blue-800 border-t-transparent rounded-full animate-spin shrink-0" />
            <p className="text-xs text-gray-500 truncate">
              กำลังอ่านไฟล์ <span className="font-medium text-gray-700">{fileName}</span>...
            </p>
          </div>
          <div className="border border-gray-100 rounded-lg divide-y divide-gray-50 overflow-hidden">
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
            <SkeletonRow />
          </div>
        </div>
      ) : (
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragActive(true);
          }}
          onDragLeave={() => setIsDragActive(false)}
          onDrop={handleDrop}
          className={`block border-2 border-dashed rounded-xl px-4 py-6 text-center cursor-pointer transition ${
            isDragActive
              ? "border-blue-400 bg-blue-50"
              : status === "error"
              ? "border-red-200 bg-red-50/40 hover:bg-red-50"
              : "border-blue-100 bg-blue-50/40 hover:bg-blue-50"
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) processFile(file);
              e.target.value = "";
            }}
          />

          {status === "error" ? (
            <>
              <FileWarning className="w-6 h-6 text-red-500 mx-auto mb-2" />
              <p className="text-sm font-medium text-red-600">{errorMessage}</p>
              <p className="text-xs text-gray-400 mt-1">กดเพื่อลองใหม่อีกครั้ง</p>
            </>
          ) : (
            <>
              <UploadCloud className="w-6 h-6 text-blue-800 mx-auto mb-2" />
              <p className="text-sm font-medium text-blue-900">
                ลากและวางไฟล์ PDF ที่นี่
              </p>
              <p className="text-xs text-gray-400 mt-1">
                หรือกดเพื่อเลือกไฟล์จากเครื่อง
              </p>
            </>
          )}
        </label>
      )}

      {/* ----- สถานะการบันทึกลงฐานข้อมูล (server upload) ----- */}
      {serverStatus !== "idle" && (
        <div
          className={`mt-3 flex items-center gap-2 px-3 py-2.5 rounded-lg text-xs font-medium ${
            serverStatus === "error"
              ? "bg-red-50 text-red-600"
              : serverStatus === "saving"
              ? "bg-blue-50 text-blue-800"
              : "bg-emerald-50 text-emerald-700"
          }`}
        >
          {serverStatus === "saving" && (
            <span className="w-3.5 h-3.5 border-2 border-blue-800 border-t-transparent rounded-full animate-spin shrink-0" />
          )}
          {serverMessage}
        </div>
      )}

      {/* ----- หน้าต่างพรีวิว (modal) แยกออกมาต่างหาก ให้ตรวจสอบก่อนกดยืนยันนำเข้า ----- */}
      {isReviewOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/40 backdrop-blur-sm"
          onClick={(e) => {
            if (e.target === e.currentTarget) resetToIdle();
          }}
        >
          <div className="w-full max-w-lg bg-white rounded-2xl shadow-xl overflow-hidden flex flex-col max-h-[85vh]">
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 shrink-0">
              <div>
                <h4 className="text-sm font-semibold text-gray-800">
                  ตรวจสอบรายการก่อนนำเข้า
                </h4>
                <p className="text-xs text-gray-400 mt-0.5">
                  พบ {extracted.length} รายการจาก {fileName}
                </p>
              </div>
              <button
                type="button"
                onClick={resetToIdle}
                className="text-gray-400 hover:text-gray-600 transition p-1"
                aria-label="ปิดหน้าต่าง"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* Body: scrollable list */}
            <div className="overflow-y-auto divide-y divide-gray-50">
              {extracted.map((t) => (
                <label
                  key={t.id}
                  className="flex items-start gap-3 px-5 py-3 hover:bg-gray-50/60 cursor-pointer transition"
                >
                  <input
                    type="checkbox"
                    checked={t.included}
                    onChange={() => toggleInclude(t.id)}
                    className="w-4 h-4 mt-0.5 rounded border-gray-300 text-blue-900 focus:ring-blue-900/30 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-sm font-medium text-gray-800 truncate">
                        {t.description}
                      </p>
                      <p
                        className={`text-sm font-medium whitespace-nowrap ${
                          t.amount >= 0 ? "text-emerald-600" : "text-red-500"
                        }`}
                      >
                        {t.amount >= 0 ? "+" : "-"}
                        {Math.abs(t.amount).toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}{" "}
                        {t.currency}
                      </p>
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">
                      {t.date} · {t.subLabel}
                    </p>
                  </div>
                </label>
              ))}
            </div>

            {/* Footer */}
            <div className="flex items-center gap-2 px-5 py-4 border-t border-gray-100 shrink-0">
              <button
                type="button"
                onClick={handleConfirmImport}
                disabled={selectedCount === 0}
                className={`flex-1 flex items-center justify-center gap-1.5 text-sm font-medium px-3 py-2.5 rounded-lg transition ${
                  selectedCount === 0
                    ? "bg-gray-100 text-gray-400 cursor-not-allowed"
                    : "bg-blue-900 hover:bg-blue-950 text-white"
                }`}
              >
                <CheckCircle2 className="w-4 h-4" />
                นำเข้า {selectedCount} รายการ
              </button>
              <button
                type="button"
                onClick={resetToIdle}
                className="text-sm font-medium px-4 py-2.5 rounded-lg text-gray-500 hover:bg-gray-50 transition"
              >
                ยกเลิก
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}