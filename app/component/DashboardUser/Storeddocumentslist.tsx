import { useEffect, useState } from "react";
import { FileText, Download, Trash2 } from "lucide-react";
import { useAuth } from "../../lib/auth";
import {
  listDocuments,
  getDocumentBlob,
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
  onViewAll?: () => void;
}

export default function StoredDocumentsList({ refreshTrigger, onViewAll }: StoredDocumentsListProps) {
  const { user } = useAuth();
  const [docs, setDocs] = useState<StoredDocumentMeta[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = async () => {
    try {
      if (!user?.id) {
        setDocs([]);
        return;
      }
      const list = await listDocuments(user.id);
      setDocs(list);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTrigger, user?.id]);

  const handleDownload = async (doc: StoredDocumentMeta) => {
    if (!user?.id) return;
    const blob = await getDocumentBlob(user.id, doc.id);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = doc.fileName;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleDelete = async (id: string) => {
    if (!user?.id) return;
    await deleteDocument(user.id, id);
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

      {docs.length === 0 ? (
        <p className="text-xs text-gray-400 text-center py-4">
          ยังไม่มีไฟล์ที่จัดเก็บไว้
        </p>
      ) : (
        <>
          <div className="space-y-2">
            {docs.slice(0, 3).map((doc) => (
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
                  onClick={() => handleDelete(doc.id)}
                  className="text-gray-400 hover:text-red-600 transition shrink-0"
                  aria-label="ลบไฟล์"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>

          {docs.length > 3 && (
            <button
              type="button"
              onClick={onViewAll}
              className="w-full text-center text-xs text-blue-800 font-medium hover:underline mt-3"
            >
              ดูทั้งหมด ({docs.length} ไฟล์) →
            </button>
          )}
        </>
      )}
    </div>
  );
}