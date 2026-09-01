import { useEffect, useState } from "react";
import { FileText, Download, Trash2 } from "lucide-react";
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

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("th-TH", { year: "numeric", month: "short", day: "numeric" });
}

// รายการนี้เก็บไฟล์ไว้แค่ในเบราว์เซอร์เครื่องนี้เท่านั้น (IndexedDB) — ไม่ใช่การเก็บบน cloud/server จริง
interface StoredDocumentsListProps {
  refreshTrigger?: number;
}

export default function StoredDocumentsList({ refreshTrigger }: StoredDocumentsListProps) {
  const { user } = useAuth();
  const [docs, setDocs] = useState<StoredDocumentMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

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
    if (!user?.id) return;
    const local = await getLocalDocumentByName(user.id, fileName);
    if (local) {
      await deleteDocument(user.id, local.id);
    }
    // Server-authoritative document row is not deleted here (no user-scoped
    // server delete endpoint yet); only the optional local IndexedDB copy.
    refresh();
  };

  if (loading) return null;

  return (
    <div className="bg-white rounded-xl border border-gray-100 p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-800">
          ไฟล์ Statement ที่จัดเก็บไว้
        </h3>
        <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-600 font-medium">
          เก็บในเครื่องนี้เท่านั้น
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
                className="text-gray-400 hover:text-red-600 transition shrink-0"
                aria-label="ลบไฟล์"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}