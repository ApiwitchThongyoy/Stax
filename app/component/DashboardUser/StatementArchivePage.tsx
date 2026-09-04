import { useEffect, useRef, useState } from "react";
import {
  Archive,
  FolderOpen,
  FileText,
  Download,
  Trash2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import { useAuth } from "../../lib/auth";
import {
  fetchUserDocuments,
  downloadUserDocument,
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
  const [downloadError, setDownloadError] = useState("");
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(
    new Set()
  );

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
        if (user.id) {
          const local = await getLocalDocumentByName(user.id, fileName);
          if (local) {
            await deleteDocument(user.id, local.id).catch(() => {});
          }
        }
        await refresh();
        // Signal the Dashboard to refresh its server-driven ledger (and the
        // stored documents list) so FX/Calendar/ledger drop the deleted
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

  const toggleFolder = (key: string) => {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const folders: Record<string, StoredDocumentMeta[]> = {};
  for (const doc of docs) {
    const key = monthFolderKey(doc.uploadedAt);
    if (!folders[key]) folders[key] = [];
    folders[key].push(doc);
  }
  const folderKeys = Object.keys(folders).sort((a, b) => (a < b ? 1 : -1));

  return (
    <div className="space-y-6">
      <div className="bg-linear-to-br from-blue-900 to-blue-950 rounded-2xl px-6 py-5 text-white">
        <p className="text-xs text-blue-300 mb-1">Statement Archive</p>
        <h1 className="text-xl font-semibold mb-1.5">คลัง Statement ทั้งหมด</h1>
        <p className="text-sm text-blue-200">
          ทั้งหมด {docs.length} ไฟล์ จัดกลุ่มตามปี/เดือน · จัดเก็บบนเซิร์ฟเวอร์อย่างปลอดภัย
        </p>
      </div>

      <div className="bg-white rounded-xl border border-gray-100 p-5">
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
              ยังไม่มีไฟล์ในคลัง
            </p>
            <p className="text-xs text-gray-400 mt-1">
              ไฟล์ที่ import จากแดชบอร์ดจะมาโผล่ที่นี่โดยอัตโนมัติ
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
                        {key}
                      </span>
                      <span className="text-xs text-gray-400">
                        ({files.length} ไฟล์)
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
                      {files.map((doc) => (
                        <div
                          key={doc.id}
                          className="flex items-center gap-2.5 px-4 py-2.5 hover:bg-gray-50 transition"
                        >
                          <FileText className="w-4 h-4 text-blue-800 shrink-0" />
                          <div className="min-w-0 flex-1">
                            <p className="text-xs font-medium text-gray-800 truncate">
                              {doc.fileName}
                            </p>
                            <p className="text-[11px] text-gray-400">
                              {formatDate(doc.uploadedAt)} ·{" "}
                              {formatFileSize(doc.size)}
                            </p>
                          </div>
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
                            onClick={() => handleDelete(doc.id, doc.fileName)}
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
                      ))}
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