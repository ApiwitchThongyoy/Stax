import { useEffect, useRef, useState } from "react";
import {
  Archive,
  FolderOpen,
  FileText,
  Download,
  Trash2,
  ChevronDown,
  ChevronRight,
  Table2,
  Search,
  X,
} from "lucide-react";
import { useAuth } from "../../lib/auth";
import {
  fetchUserDocuments,
  downloadUserDocument,
  fetchDocumentTransactions,
  type DocumentTransactionsResponse,
} from "../../lib/server-api";
import {
  getLocalDocumentByName,
  deleteDocument,
  type StoredDocumentMeta,
} from "../../lib/Documentstorage";
import {
  InFlightDeletionGuard,
  classifyDeleteDocumentResponse,
} from "../../lib/document-delete";

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("th-TH", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function monthFolderKey(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}/${m}`;
}

interface StatementArchivePageProps {
  onDocumentDeleted?: () => void;
}

export default function StatementArchivePage({
  onDocumentDeleted,
}: StatementArchivePageProps) {
  const { user } = useAuth();
  const [docs, setDocs] = useState<StoredDocumentMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(new Set());
  const [deleteError, setDeleteError] = useState("");
  const [pendingDelete, setPendingDelete] = useState<StoredDocumentMeta | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const confirmationInFlight = useRef(false);
  const [downloadError, setDownloadError] = useState("");
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set()
  );
  const [query, setQuery] = useState("");

  // Per-document transaction view (server-authoritative). One document can be
  // expanded at a time; the panel closes when the user clicks the same row,
  // opens a different one, or deletes the document.
  const [viewingDocId, setViewingDocId] = useState<string | null>(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewError, setViewError] = useState("");
  const [view, setView] = useState<DocumentTransactionsResponse | null>(null);

  // Per-document in-flight deletion guard. `deletingIds` is React state ONLY
  // to drive each row's disabled/pending UI; the authoritative guard is a
  // synchronous ref (`inFlight`) so rapid clicks on the same document (even
  // before React re-renders) cannot fire a second DELETE for that id. The guard
  // is keyed by id, so different documents delete independently.
  const inFlight = useRef(
    new InFlightDeletionGuard((id, isDeleting) => {
      setDeletingIds((prev) => {
        const next = new Set(prev);
        if (isDeleting) next.add(id);
        else next.delete(id);
        return next;
      });
    })
  );

  const refresh = async () => {
    setLoading(true);
    try {
      if (!user?.accessToken) {
        setDocs([]);
        return;
      }
      const list = await fetchUserDocuments(user.accessToken);
      setDocs(
        list.map((d) => ({
          id: d.id,
          fileName: d.originalName,
          uploadedAt: d.createdAt,
          size: d.fileSize,
          transactionCount: d.transactionCount,
        }))
      );
      if (list.length > 0) {
        setExpandedFolders(new Set([monthFolderKey(list[0].createdAt)]));
      }
    } catch {
      // Best-effort revalidation: keep whatever we already have on a failed
      // fetch so a transient error cannot crash the delete flow or blank the UI.
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.accessToken]);

  const handleDownload = async (doc: StoredDocumentMeta) => {
    // The server is authoritative for the file bytes: we fetch the PDF from
    // GET /api/v1/documents/:id/download and save the returned Blob. IndexedDB
    // is no longer the source of truth for download.
    if (!user?.accessToken) return;
    setDownloadError("");
    try {
      const { blob, filename } = await downloadUserDocument(
        user.accessToken,
        doc.id,
        doc.fileName
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setDownloadError("ไม่สามารถดาวน์โหลดไฟล์ได้ กรุณาลองใหม่อีกครั้ง");
    }
  };

  const handleDelete = async (id: string, fileName: string) => {
    if (!user?.accessToken) return;

    // Duplicate-submit prevention: if this document id already has a DELETE in
    // flight, ignore the repeat click entirely — no second network call is
    // made, and that row's delete button is disabled while deleting anyway.
    const { started, result: response } = await inFlight.current.run(
      id,
      async () => {
        let res: Response;
        try {
          res = await fetch(`/api/v1/documents/${id}`, {
            method: "DELETE",
            headers: {
              Authorization: `Bearer ${user.accessToken}`,
            },
          });
        } catch {
          return { status: 0, ok: false };
        }
        return { status: res.status, ok: res.ok };
      }
    );

    if (!started) return; // another delete attempt for the same id is in flight

    // `response` is always set when `started` is true.
    const outcome = classifyDeleteDocumentResponse(response!);

    switch (outcome.kind) {
      case "deleted":
      case "gone": {
        // Server confirmed the document is gone (either deleted by this request
        // or already deleted earlier). Remove the optional local IndexedDB copy
        // as cleanup only, then revalidate the list so no stale row remains.
        setDeleteError("");
        if (viewingDocId === id) {
          setViewingDocId(null);
          setView(null);
          setViewError("");
        }
        if (user.id) {
          const local = await getLocalDocumentByName(user.id, fileName);
          if (local) {
            await deleteDocument(user.id, local.id).catch(() => {});
          }
        }
        await refresh();
        // Signal the Dashboard to refresh its server-driven ledger (and the
        // stored documents list) so the home/ledger views drop the deleted
        // source's rows.
        onDocumentDeleted?.();
        break;
      }
      case "auth":
        // Real 401/403 authorization failure — never swallow it. Surface a
        // controlled message and leave the row in place (nothing was deleted).
        setDeleteError(
          outcome.status === 401
            ? "เซสชันหมดอายุหรือไม่ถูกต้อง กรุณาเข้าสู่ระบบอีกครั้ง"
            : "คุณไม่มีสิทธิ์ลบไฟล์นี้"
        );
        break;
      case "error":
        // Genuine failure: keep the row (server did NOT confirm deletion),
        // re-enable the delete control (guard already released the id), and
        // show one controlled error.
        setDeleteError(outcome.message);
        break;
    }
  };

  useEffect(() => {
    if (pendingDelete) deleteDialog.current?.showModal();
    else deleteDialog.current?.close();
  }, [pendingDelete]);

  const cancelDelete = () => {
    if (!confirmationInFlight.current) setPendingDelete(null);
  };

  const confirmDelete = async () => {
    if (!pendingDelete || confirmationInFlight.current) return;
    confirmationInFlight.current = true;
    setConfirmingDelete(true);
    try {
      await handleDelete(pendingDelete.id, pendingDelete.fileName);
    } finally {
      setPendingDelete(null);
      setConfirmingDelete(false);
      confirmationInFlight.current = false;
    }
  };

  const toggleFolder = (key: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleViewTransactions = async (doc: StoredDocumentMeta) => {
    if (!user?.accessToken) return;
    // Clicking the same row toggles the panel closed; a different row switches.
    if (viewingDocId === doc.id) {
      setViewingDocId(null);
      setView(null);
      setViewError("");
      return;
    }
    setViewingDocId(doc.id);
    setView(null);
    setViewError("");
    setViewLoading(true);
    try {
      const data = await fetchDocumentTransactions(user.accessToken, doc.id);
      setView(data);
      setViewError("");
    } catch {
      setViewError("ไม่สามารถโหลดธุรกรรมของเอกสารนี้ได้ กรุณาลองใหม่อีกครั้ง");
      setView(null);
    } finally {
      setViewLoading(false);
    }
  };

  const folders: Record<string, StoredDocumentMeta[]> = {};
  const searching = query.trim() !== "";
  const filteredDocs = searching
    ? docs.filter((doc) =>
        doc.fileName.toLowerCase().includes(query.trim().toLowerCase())
      )
    : docs;
  for (const doc of filteredDocs) {
    const key = monthFolderKey(doc.uploadedAt);
    if (!folders[key]) folders[key] = [];
    folders[key].push(doc);
  }
  const folderKeys = Object.keys(folders).sort((a, b) => (a < b ? 1 : -1));

  return (
    <div className="space-y-6">
      <dialog
        ref={deleteDialog}
        aria-labelledby="statement-delete-title"
        aria-describedby="statement-delete-message statement-delete-warning"
        onCancel={(event) => { event.preventDefault(); cancelDelete(); }}
        className="fixed inset-0 m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl bg-white p-6 shadow-xl backdrop:bg-black/40"
      >
        <h2 id="statement-delete-title" className="text-lg font-semibold text-gray-900">
          ยืนยันการลบ Statement
        </h2>
        <p id="statement-delete-message" className="mt-3 text-sm text-gray-700 break-words">
          คุณต้องการลบ "{pendingDelete?.fileName}" จริงหรือไม่?
        </p>
        <p id="statement-delete-warning" className="mt-3 rounded-lg bg-red-50 p-3 text-sm text-red-600">
          การลบจะนำข้อมูลธุรกรรมและข้อมูลทางการเงินที่สร้างจาก Statement นี้ออกด้วย
        </p>
        <div className="mt-5 flex justify-end gap-3">
          <button type="button" autoFocus onClick={cancelDelete} disabled={confirmingDelete}
            className="rounded-lg border border-gray-200 bg-white px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50">
            ยกเลิก
          </button>
          <button type="button" onClick={confirmDelete} disabled={confirmingDelete}
            className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50 disabled:cursor-wait">
            {confirmingDelete ? "กำลังลบ..." : "ลบเอกสาร"}
          </button>
        </div>
      </dialog>
      <div className="bg-linear-to-br from-blue-900 to-blue-950 rounded-2xl px-6 py-5 text-white">
        <p className="text-xs text-blue-300 mb-1">Statement Archive</p>
        <h1 className="text-xl font-semibold mb-1.5">คลัง Statement ทั้งหมด</h1>
        <p className="text-sm text-blue-200">
          ทั้งหมด {docs.length} ไฟล์ จัดกลุ่มตามปี/เดือน · จัดเก็บบนเซิร์ฟเวอร์อย่างปลอดภัย
        </p>
      </div>

      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="relative flex-1 min-w-[220px]">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="ค้นหาชื่อไฟล์…"
              className="w-full pl-9 pr-3 py-2 text-sm bg-white text-gray-900 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900 transition"
            />
          </div>
          {searching && (
            <>
              <span className="text-xs text-gray-500">
                พบ {filteredDocs.length} จาก {docs.length} ไฟล์
              </span>
              <button
                type="button"
                onClick={() => setQuery("")}
                className="bg-white border border-gray-200 hover:bg-gray-50 text-gray-600 text-xs font-medium px-3 py-2 rounded-lg transition"
              >
                ล้าง
              </button>
            </>
          )}
        </div>
        {deleteError && (
          <div className="mb-4 flex items-center gap-2 px-3 py-2.5 rounded-lg bg-red-50 text-red-600 text-sm">
            <span aria-hidden="true">!</span>
            <span>{deleteError}</span>
          </div>
        )}
        {downloadError && (
          <div className="mb-4 flex items-center gap-2 px-3 py-2.5 rounded-lg bg-red-50 text-red-600 text-sm">
            <span aria-hidden="true">!</span>
            <span>{downloadError}</span>
          </div>
        )}
        {loading ? (
          <p className="text-sm text-gray-400 text-center py-8">กำลังโหลด...</p>
        ) : folderKeys.length === 0 ? (
          <div className="text-center py-12">
            <Archive className="w-8 h-8 text-gray-300 mx-auto mb-3" />
            <p className="text-sm font-medium text-gray-600">
              {searching ? "ไม่พบไฟล์ที่ค้นหา" : "ยังไม่มีไฟล์ในคลัง"}
            </p>
            <p className="text-xs text-gray-400 mt-1">
              {searching
                ? "ลองเปลี่ยนคำค้นหา"
                : "ไฟล์ที่ import จากแดชบอร์ดจะมาโผล่ที่นี่โดยอัตโนมัติ"}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {folderKeys.map((key) => {
              const isOpen = expandedFolders.has(key);
              const files = folders[key];
              return (
                <div
                  key={key}
                  className="border border-gray-100 rounded-lg overflow-hidden"
                >
                  <button
                    type="button"
                    onClick={() => toggleFolder(key)}
                    className="w-full flex items-center justify-between px-4 py-3 bg-gray-50/60 hover:bg-gray-50 transition"
                  >
                    <div className="flex items-center gap-2">
                      <FolderOpen className="w-4 h-4 text-blue-800 shrink-0" />
                      <span className="text-sm font-medium text-gray-800">
                        อัปโหลดเมื่อ {key} ({files.length} ไฟล์)
                      </span>
                    </div>
                    {isOpen ? (
                      <ChevronDown className="w-4 h-4 text-gray-400" />
                    ) : (
                      <ChevronRight className="w-4 h-4 text-gray-400" />
                    )}
                  </button>

                  {isOpen && (
                    <div className="divide-y divide-gray-50">
                      {files.map((doc) => {
                        const isViewing = viewingDocId === doc.id;
                        return (
                          <div key={doc.id}>
                            <div className="flex items-center gap-2.5 px-4 py-2.5 hover:bg-gray-50 transition">
                              <FileText className="w-4 h-4 text-blue-800 shrink-0" />
                              <div className="min-w-0 flex-1">
                                <p className="text-xs font-medium text-gray-800 truncate">
                                  {doc.fileName}
                                </p>
                                <p className="text-[11px] text-gray-400">
                                  {formatDate(doc.uploadedAt)} ·{" "}
                                  {formatFileSize(doc.size)}
                                  {typeof doc.transactionCount === "number" &&
                                  doc.transactionCount > 0
                                    ? ` · ${doc.transactionCount} รายการ`
                                    : ""}
                                </p>
                              </div>
                              <button
                                type="button"
                                onClick={() => handleViewTransactions(doc)}
                                className={`transition shrink-0 ${
                                  isViewing
                                    ? "text-blue-800"
                                    : "text-gray-400 hover:text-blue-800"
                                }`}
                                aria-label={
                                  isViewing ? "ปิดดูธุรกรรม" : "ดูธุรกรรม"
                                }
                                title={
                                  isViewing ? "ปิดดูธุรกรรม" : "ดูธุรกรรม"
                                }
                              >
                                <Table2 className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDownload(doc)}
                                className="text-gray-400 hover:text-blue-800 transition shrink-0"
                                aria-label="ดาวน์โหลด"
                              >
                                <Download className="w-3.5 h-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => setPendingDelete(doc)}
                                disabled={deletingIds.has(doc.id)}
                                className="text-gray-400 hover:text-red-600 transition shrink-0 disabled:opacity-50 disabled:cursor-wait disabled:hover:text-gray-400"
                                aria-label={deletingIds.has(doc.id) ? "กำลังลบไฟล์" : "ลบไฟล์"}
                                title={deletingIds.has(doc.id) ? "กำลังลบ..." : "ลบไฟล์"}
                              >
                                {deletingIds.has(doc.id) ? (
                                  <span className="inline-block w-3.5 h-3.5 border-2 border-gray-300 border-t-gray-500 rounded-full animate-spin" />
                                ) : (
                                  <Trash2 className="w-3.5 h-3.5" />
                                )}
                              </button>
                            </div>

                            {isViewing && (
                              <div className="border-t border-gray-100 bg-gray-50/40 px-4 py-4">
                                {viewLoading ? (
                                  <p className="text-sm text-gray-400 text-center py-6">
                                    กำลังโหลดธุรกรรม...
                                  </p>
                                ) : viewError ? (
                                  <div className="flex flex-col items-center gap-2 py-6">
                                    <p className="text-xs text-red-600">
                                      {viewError}
                                    </p>
                                    <button
                                      type="button"
                                      onClick={() => handleViewTransactions(doc)}
                                      className="inline-flex items-center gap-1.5 bg-white border border-gray-200 hover:bg-gray-50 text-gray-600 text-xs font-medium px-3 py-1.5 rounded-lg transition"
                                    >
                                      ลองใหม่
                                    </button>
                                  </div>
                                ) : view && view.stats.total === 0 ? (
                                  <div className="text-center py-6">
                                    <FileText className="w-6 h-6 text-gray-300 mx-auto mb-2" />
                                    <p className="text-xs text-gray-500">
                                      เอกสารนี้ไม่มีธุรกรรมในระบบ
                                    </p>
                                  </div>
                                ) : view ? (
                                  <div className="space-y-3">
                                    <div className="flex items-center justify-between gap-2">
                                      <p className="text-xs font-semibold text-gray-700 truncate">
                                        ธุรกรรมจาก {view.documentName}
                                      </p>
                                      <button
                                        type="button"
                                        onClick={() =>
                                          handleViewTransactions(doc)
                                        }
                                        className="text-gray-400 hover:text-gray-600 transition shrink-0"
                                        aria-label="ปิดดูธุรกรรม"
                                      >
                                        <X className="w-3.5 h-3.5" />
                                      </button>
                                    </div>

                                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                                      <div className="bg-white rounded-xl p-3 text-center border border-gray-100">
                                        <p className="text-lg font-bold text-gray-800">
                                          {view.stats.total}
                                        </p>
                                        <p className="text-[11px] text-gray-500 mt-0.5">
                                          นำเข้าทั้งหมด
                                        </p>
                                      </div>
                                      <div className="bg-emerald-50 rounded-xl p-3 text-center">
                                        <p className="text-lg font-bold text-emerald-600">
                                          {view.stats.buyCount}
                                        </p>
                                        <p className="text-[11px] text-emerald-700/80 mt-0.5">
                                          ซื้อ (BUY)
                                        </p>
                                      </div>
                                      <div className="bg-red-50 rounded-xl p-3 text-center">
                                        <p className="text-lg font-bold text-red-600">
                                          {view.stats.sellCount}
                                        </p>
                                        <p className="text-[11px] text-red-700/80 mt-0.5">
                                          ขาย (SELL)
                                        </p>
                                      </div>
                                      <div className="bg-gray-50 rounded-xl p-3 text-center">
                                        <p className="text-lg font-bold text-gray-800">
                                          {view.stats.cashCount}
                                        </p>
                                        <p className="text-[11px] text-gray-500 mt-0.5">
                                          เงินสด (CASH)
                                        </p>
                                      </div>
                                      <div className="bg-gray-50 rounded-xl p-3 text-center">
                                        <p className="text-lg font-bold text-gray-800">
                                          {view.stats.computableSellCount}
                                        </p>
                                        <p className="text-[11px] text-gray-500 mt-0.5">
                                          SELL คำนวณกำไรได้
                                        </p>
                                      </div>
                                      <div className="bg-gray-50 rounded-xl p-3 text-center">
                                        <p className="text-lg font-bold text-gray-800">
                                          {view.stats.fxRates.length}
                                        </p>
                                        <p className="text-[11px] text-gray-500 mt-0.5">
                                          อัตราจาก Statement
                                        </p>
                                        {view.stats.fxRates.length > 0 && (
                                          <p className="text-[10px] text-gray-400 mt-1 truncate">
                                            {view.stats.fxRates.join(", ")}
                                          </p>
                                        )}
                                      </div>
                                    </div>

                                    <div className="border border-gray-100 rounded-lg overflow-x-auto bg-white">
                                      <table className="w-full text-xs whitespace-nowrap">
                                        <thead>
                                          <tr className="bg-gray-50 text-left text-gray-500">
                                            <th className="px-3 py-2 font-medium">
                                              วันที่
                                            </th>
                                            <th className="px-3 py-2 font-medium">
                                              รายการ
                                            </th>
                                            <th className="px-3 py-2 font-medium">
                                              ฝั่ง
                                            </th>
                                            <th className="px-3 py-2 font-medium text-right">
                                              จำนวน
                                            </th>
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
                                          {view.transactions.map((r) => (
                                            <tr
                                              key={r.transactionId}
                                              className="hover:bg-gray-50/60"
                                            >
                                              <td className="px-3 py-2 text-gray-500">
                                                {r.transactionDate}
                                              </td>
                                              <td className="px-3 py-2 text-gray-800 font-medium">
                                                {r.symbol
                                                  ? `${r.symbol} · ${
                                                      r.section ?? "—"
                                                    }`
                                                  : r.section ?? "—"}
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
                                                  <span className="text-gray-300">
                                                    —
                                                  </span>
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
                                                {r.type === "CASH_OUT"
                                                  ? "-"
                                                  : "+"}
                                                {Number(
                                                  r.amountForeign
                                                ).toLocaleString(undefined, {
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
                                                  r.realizedGainLossThb !=
                                                    null &&
                                                  Number(
                                                    r.realizedGainLossThb
                                                  ) >= 0
                                                    ? "text-emerald-600"
                                                    : "text-red-500"
                                                }`}
                                              >
                                                {r.realizedGainLossThb != null
                                                  ? Number(
                                                      r.realizedGainLossThb
                                                    ).toLocaleString(
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
                                  </div>
                                ) : null}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
