import { useEffect, useState } from "react";
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

// ป้ายโฟลเดอร์ตามปี/เดือน เช่น "2026/04" — จัดกลุ่มจากวันที่อัปโหลดไฟล์ (uploadedAt)
function monthFolderKey(iso: string): string {
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}/${m}`;
}

// รายการนี้เก็บไฟล์ไว้แค่ในเบราว์เซอร์เครื่องนี้เท่านั้น (IndexedDB) — ไม่ใช่การเก็บบน cloud/server จริง
export default function StatementArchivePage() {
  const { user } = useAuth();
  const [docs, setDocs] = useState<StoredDocumentMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  const refresh = async () => {
    setLoading(true);
    try {
      if (!user?.id) {
        setDocs([]);
        return;
      }
      const list = await listDocuments(user.id);
      setDocs(list);
      // เปิดโฟลเดอร์ล่าสุดไว้ให้อัตโนมัติ ใช้งานสะดวกขึ้น
      if (list.length > 0) {
        setExpandedFolders(new Set([monthFolderKey(list[0].uploadedAt)]));
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

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
    <>
      {/* Intro banner */}
      <div className="bg-linear-to-br from-blue-900 to-blue-950 rounded-2xl px-6 py-5 text-white">
        <p className="text-xs text-blue-300 mb-1">Statement Archive</p>
        <h1 className="text-xl font-semibold mb-1.5">คลัง Statement ทั้งหมด</h1>
        <p className="text-sm text-blue-200">
          ทั้งหมด {docs.length} ไฟล์ แบ่งเป็นโฟลเดอร์ตามปี/เดือน · จัดเก็บไว้ในเครื่องนี้เท่านั้น
        </p>
      </div>

      {/* Folder browser */}
      <div className="bg-white rounded-xl border border-gray-100 p-5 mt-6">
        {loading ? (
          <p className="text-sm text-gray-400 text-center py-8">กำลังโหลด...</p>
        ) : folderKeys.length === 0 ? (
          <div className="text-center py-12">
            <Archive className="w-8 h-8 text-gray-300 mx-auto mb-3" />
            <p className="text-sm font-medium text-gray-600">ยังไม่มีไฟล์ในคลัง</p>
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
                <div key={key} className="border border-gray-100 rounded-lg overflow-hidden">
                  <button
                    type="button"
                    onClick={() => toggleFolder(key)}
                    className="w-full flex items-center justify-between px-4 py-3 bg-gray-50/60 hover:bg-gray-100/60 transition"
                  >
                    <div className="flex items-center gap-2">
                      <FolderOpen className="w-4 h-4 text-blue-800 shrink-0" />
                      <span className="text-sm font-medium text-gray-800">{key}</span>
                      <span className="text-xs text-gray-400">({files.length} ไฟล์)</span>
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
                          className="flex items-center gap-2.5 px-4 py-2.5 hover:bg-gray-50/60 transition"
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
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}