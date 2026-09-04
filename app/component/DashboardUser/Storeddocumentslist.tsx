import { useEffect, useRef, useState } from "react";
import { FileText, Download, Trash2, Loader2 } from "lucide-react";
import { useAuth } from "../../lib/auth";
import { fetchUserDocuments, downloadUserDocument } from "../../lib/server-api";
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
  return d.toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
}

interface StoredDocumentsListProps {
  refreshTrigger?: number;
}

export default function StoredDocumentsList({ refreshTrigger }: StoredDocumentsListProps) {
  const { user } = useAuth();
  const [docs, setDocs] = useState<StoredDocumentMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [deletingIds, setDeletingIds] = useState<ReadonlySet<string>>(new Set());

  // Per-document in-flight deletion guard (synchronous ref, keyed by id) so
  // rapid clicks on the same document cannot fire duplicate DELETEs, while
  // different documents still delete independently.
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
    } catch {
      // Best-effort revalidation: keep whatever we already have on a failed
      // fetch so a transient error cannot crash the delete flow.
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTrigger, user?.accessToken]);

  const handleDownload = async (doc: StoredDocumentMeta) => {
    // The server is the source of truth for the file bytes (GET
    // /api/v1/documents/:id/download). IndexedDB is no longer authoritative.
    if (!user?.accessToken) return;
    setError("");
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
      setError("ไม่สามารถดาวน์โหลดไฟล์ได้ กรุณาลองใหม่อีกครั้ง");
    }
  };

  const handleDelete = async (id: string, fileName: string) => {
    if (!user?.accessToken) return;

    // Duplicate-submit prevention: if this document id already has a DELETE in
    // flight, ignore the repeat click entirely — no second network call is made.
    const { started, result: response } = await inFlight.current.run(
      id,
      async () => {
        let res: Response;
        try {
          res = await fetch(`/api/v1/documents/${id}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${user.accessToken}` },
          });
        } catch {
          return { status: 0, ok: false };
        }
        return { status: res.status, ok: res.ok };
      }
    );

    if (!started) return; // another delete attempt for the same id is in flight

    const outcome = classifyDeleteDocumentResponse(response!);

    switch (outcome.kind) {
      case "deleted":
      case "gone": {
        // Server confirmed the document is gone. Best-effort cleanup of the
        // optional local IndexedDB copy (not authority), then revalidate.
        setError("");
        if (user.id) {
          const local = await getLocalDocumentByName(user.id, fileName);
          if (local) {
            await deleteDocument(user.id, local.id).catch(() => {});
          }
        }
        break;
      }
      case "auth":
        // Real 401/403 — never swallow it.
        setError(
          outcome.status === 401
            ? "เซสชันหมดอายุหรือไม่ถูกต้อง กรุณาเข้าสู่ระบบอีกครั้ง"
            : "คุณไม่มีสิทธิ์ลบไฟล์นี้"
        );
        break;
      case "error":
        setError(outcome.message);
        break;
    }
    refresh();
  };

  if (loading) return null;

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-800">
          ไฟล์ Statement ที่จัดเก็บไว้
        </h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600 font-medium">
          บนเซิร์ฟเวอร์
        </span>
      </div>

      {error && (
        <p className="text-[11px] text-red-600 mb-2">{error}</p>
      )}

      {docs.length === 0 ? (
        <p className="text-xs text-gray-400 text-center py-4">
          ยังไม่มีไฟล์ที่จัดเก็บไว้
        </p>
      ) : (
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {docs.map((doc) => (
            <div
              key={doc.id}
              className="flex items-center gap-2.5 px-3 py-2.5 rounded-lg border border-gray-100 hover:bg-gray-50/60 transition"
            >
              <FileText className="w-4 h-4 text-blue-800 shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-gray-800 truncate">
                  {doc.fileName}
                </p>
                <p className="text-[11px] text-gray-400">
                  {formatDate(doc.uploadedAt)} · {formatFileSize(doc.size)}
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
                className="text-gray-400 hover:text-red-600 transition shrink-0 disabled:opacity-40 disabled:cursor-wait disabled:hover:text-gray-400"
                aria-label={deletingIds.has(doc.id) ? "กำลังลบไฟล์" : "ลบไฟล์"}
                title={deletingIds.has(doc.id) ? "กำลังลบ..." : "ลบไฟล์"}
              >
                {deletingIds.has(doc.id) ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
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
}