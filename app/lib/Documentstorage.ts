// เก็บไฟล์ PDF statement ต้นฉบับไว้ใน IndexedDB ของเบราว์เซอร์
// หมายเหตุสำคัญ: นี่คือ "เก็บไว้ในเครื่องนี้เท่านั้น" ไม่ใช่การเก็บบน cloud/server จริง
// เหมาะสำหรับดูย้อนหลังในเครื่องเดิม ไม่ใช่ enterprise-grade secure storage
// (ถ้าอนาคตมี backend ควรย้ายมาเก็บบน server + object storage แทน)

const DB_NAME = "stax_documents_db";
const DB_VERSION = 1;
const STORE_NAME = "documents";

export interface StoredDocumentMeta {
  id: string;
  fileName: string;
  uploadedAt: string; // ISO timestamp
  size: number; // bytes
}

interface StoredDocumentRecord extends StoredDocumentMeta {
  blob: Blob;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined" || !window.indexedDB) {
      reject(new Error("IndexedDB ใช้งานได้เฉพาะฝั่งเบราว์เซอร์เท่านั้น"));
      return;
    }
    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

let counter = 0;
function nextDocumentId(): string {
  counter += 1;
  return `doc-${Date.now()}-${counter}`;
}

export async function saveDocument(file: File): Promise<StoredDocumentMeta> {
  const db = await openDb();
  const meta: StoredDocumentMeta = {
    id: nextDocumentId(),
    fileName: file.name,
    uploadedAt: new Date().toISOString(),
    size: file.size,
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const record: StoredDocumentRecord = { ...meta, blob: file };
    store.put(record);
    tx.oncomplete = () => resolve(meta);
    tx.onerror = () => reject(tx.error);
  });
}

export async function listDocuments(): Promise<StoredDocumentMeta[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();
    request.onsuccess = () => {
      const records = request.result as StoredDocumentRecord[];
      const metas = records
        .map(({ id, fileName, uploadedAt, size }) => ({ id, fileName, uploadedAt, size }))
        .sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1));
      resolve(metas);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function getDocumentBlob(id: string): Promise<Blob | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(id);
    request.onsuccess = () => {
      const record = request.result as StoredDocumentRecord | undefined;
      resolve(record ? record.blob : null);
    };
    request.onerror = () => reject(request.error);
  });
}

export async function deleteDocument(id: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}