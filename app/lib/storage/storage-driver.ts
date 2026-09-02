// Persistent Statement PDF storage — pluggable driver.
//
// Two drivers serve the same interface:
//   - `localStorageDriver`: the historical filesystem store under
//     storage/statements/*, used for local development and for automated tests
//     so they never touch live Supabase Storage. New local uploads still use the
//     `statements/<userId>/<documentId>.pdf` object key shape, stored underneath
//     STATEMENTS_DIR so a manual/local fallback mirrors production exactly.
//   - `supabaseStorageDriver`: private Supabase Storage bucket for production
//     (Vercel). Uses the service-role key server-side ONLY; the key, bucket, and
//     project URL are never exposed to the client, and object keys are generated
//     server-side (`statements/<userId>/<documentId>.pdf`) — never trusted from
//     the request.
//
// Driver selection:
//   - STORAGE_MODE=supabase  -> force Supabase Storage
//   - STORAGE_MODE=local     -> force the local filesystem store
//   - unset                  -> supabase when SUPABASE_URL +
//                               SUPABASE_SERVICE_ROLE_KEY +
//                               SUPABASE_STORAGE_BUCKET are all present,
//                               otherwise local.
//
// Supabase Storage requires no schema/migration change: the storage object key
// (a stable, contained path) is what gets persisted in documents.file_path.
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  STATEMENTS_DIR,
  safeResolveStoredPath,
} from "./statement-path";

export type StorageMode = "local" | "supabase";

const SUPABASE_OBJECT_KEY_RE =
  /^statements\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\.pdf$/;

export interface StorePdfInput {
  key: string;
  bytes: Uint8Array;
}

export type StorePdfResult =
  | { ok: true }
  | { ok: false; status: number; message: string };

export interface StatementStorageDriver {
  storePdf(input: StorePdfInput): Promise<StorePdfResult>;
  readPdf(key: string): Promise<Uint8Array | null>;
  deletePdf(key: string): Promise<boolean>;
}

/**
 * Build the server-side storage object key for a Statement PDF. Always generated
 * server-side from the authenticated user's id and a fresh document id — a
 * client-supplied object path is never used.
 */
export function buildObjectKey(userId: string, documentId: string): string {
  return `statements/${userId}/${documentId}.pdf`;
}

function isNotFoundStorageError(error: unknown): boolean {
  const maybe = error as { statusCode?: unknown; message?: string };
  const status = maybe.statusCode ?? (error as { status?: unknown }).status;
  const message = (maybe.message ?? "").toLowerCase();
  return (
    status === 404 ||
    status === "404" ||
    message.includes("not found") ||
    message.includes("not_found") ||
    message.includes("does not exist")
  );
}

// ---------------------------------------------------------------------------
// Local filesystem driver (development + automated tests)
// ---------------------------------------------------------------------------

/**
 * Resolve a stored value (object key or legacy absolute path) to a file strictly
 * inside STATEMENTS_DIR. New uploads persist relative object keys; historical
 * rows may still hold absolute paths — both are bounded to STATEMENTS_DIR.
 */
function resolveLocalPath(key: string): string | null {
  if (!key || typeof key !== "string") return null;
  if (path.isAbsolute(key)) {
    // Legacy absolute-path rows from before object keys.
    return safeResolveStoredPath(key, STATEMENTS_DIR);
  }
  return safeResolveStoredPath(path.join(STATEMENTS_DIR, key), STATEMENTS_DIR);
}

async function localStorePdf({
  key,
  bytes,
}: StorePdfInput): Promise<StorePdfResult> {
  const resolved = resolveLocalPath(key);
  if (!resolved) {
    return { ok: false, status: 400, message: "Invalid storage path" };
  }
  try {
    await mkdir(path.dirname(resolved), { recursive: true });
    await writeFile(resolved, Buffer.from(bytes));
    return { ok: true };
  } catch (error) {
    console.error("localStorageDriver.storePdf: failed", error);
    return { ok: false, status: 500, message: "Internal server error" };
  }
}

async function localReadPdf(key: string): Promise<Uint8Array | null> {
  const resolved = resolveLocalPath(key);
  if (!resolved) return null;
  try {
    return new Uint8Array(await readFile(resolved));
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw error;
  }
}

async function localDeletePdf(key: string): Promise<boolean> {
  const resolved = resolveLocalPath(key);
  if (!resolved) {
    console.warn("localStorageDriver.deletePdf: refusing path outside store");
    return true;
  }
  try {
    await unlink(resolved);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return true;
    console.warn("localStorageDriver.deletePdf: failed to remove file", error);
    return false;
  }
}

export const localStorageDriver: StatementStorageDriver = {
  storePdf: localStorePdf,
  readPdf: localReadPdf,
  deletePdf: localDeletePdf,
};

// ---------------------------------------------------------------------------
// Supabase Storage driver (production)
// ---------------------------------------------------------------------------

let cachedClient: SupabaseClient | null = null;

function supabaseClient(): SupabaseClient {
  if (cachedClient) return cachedClient;
  const url = process.env.SUPABASE_URL ?? "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !serviceRoleKey) {
    throw new Error(
      "Supabase Storage is not configured (SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SUPABASE_STORAGE_BUCKET)"
    );
  }
  cachedClient = createClient(url, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
  return cachedClient;
}

/** The private bucket name. Bucket identity is never exposed to the client. */
function supabaseBucket(): string {
  const bucket = process.env.SUPABASE_STORAGE_BUCKET ?? "";
  if (!bucket) {
    throw new Error("Supabase Storage bucket is not configured");
  }
  return bucket;
}

async function supabaseStorePdf({
  key,
  bytes,
}: StorePdfInput): Promise<StorePdfResult> {
  if (!SUPABASE_OBJECT_KEY_RE.test(key)) {
    console.warn("supabaseStorePdf: rejecting invalid object key");
    return { ok: false, status: 500, message: "Internal server error" };
  }
  try {
    const { error } = await supabaseClient()
      .storage.from(supabaseBucket())
      .upload(key, bytes, {
        contentType: "application/pdf",
        upsert: false,
        cacheControl: "0",
      });
    if (error) {
      console.error("supabaseStorePdf: upload failed", error.message);
      return { ok: false, status: 500, message: "Internal server error" };
    }
    return { ok: true };
  } catch (error) {
    console.error("supabaseStorePdf: upload threw", error);
    return { ok: false, status: 500, message: "Internal server error" };
  }
}

async function supabaseReadPdf(key: string): Promise<Uint8Array | null> {
  if (!SUPABASE_OBJECT_KEY_RE.test(key)) return null;
  try {
    const { data, error } = await supabaseClient()
      .storage.from(supabaseBucket())
      .download(key);
    if (error) {
      if (isNotFoundStorageError(error)) return null;
      console.warn(
        "supabaseReadPdf: download failed (sanitized)",
        error.message
      );
      throw new Error("storage download failed");
    }
    return new Uint8Array(await data.arrayBuffer());
  } catch (error) {
    if (error instanceof Error && error.message === "storage download failed") {
      throw error;
    }
    console.warn("supabaseReadPdf: download threw", error);
    throw new Error("storage download failed");
  }
}

async function supabaseDeletePdf(key: string): Promise<boolean> {
  if (!SUPABASE_OBJECT_KEY_RE.test(key)) {
    console.warn("supabaseDeletePdf: refusing invalid object key");
    return true;
  }
  try {
    const { error } = await supabaseClient()
      .storage.from(supabaseBucket())
      .remove([key]);
    if (error) {
      if (isNotFoundStorageError(error)) return true;
      console.warn("supabaseDeletePdf: remove failed", error.message);
      return false;
    }
    return true;
  } catch (error) {
    console.warn("supabaseDeletePdf: remove threw", error);
    return false;
  }
}

export const supabaseStorageDriver: StatementStorageDriver = {
  storePdf: supabaseStorePdf,
  readPdf: supabaseReadPdf,
  deletePdf: supabaseDeletePdf,
};

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

export function resolveStorageMode(): StorageMode {
  const override = (process.env.STORAGE_MODE ?? "").trim().toLowerCase();
  if (override === "supabase" || override === "local") return override;
  const configured =
    !!process.env.SUPABASE_URL &&
    !!process.env.SUPABASE_SERVICE_ROLE_KEY &&
    !!process.env.SUPABASE_STORAGE_BUCKET;
  return configured ? "supabase" : "local";
}

export function getStorageDriver(): StatementStorageDriver {
  return resolveStorageMode() === "supabase"
    ? supabaseStorageDriver
    : localStorageDriver;
}