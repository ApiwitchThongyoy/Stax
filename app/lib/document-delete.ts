// ---------------------------------------------------------------------------
// Statement (document) delete coordination — pure, DOM-free logic.
//
// The Statement Library ("คลัง Statement") can receive rapid, repeated clicks
// on the same document's delete/trash control. Without a synchronous in-flight
// guard, each click fires its own DELETE to /api/v1/documents/:id. The first
// succeeds (200) and the now-concurrent duplicates hit the backend after the
// row is gone, returning 404 (observed as repeated "404 Not Found" with the
// same document id requested more than once).
//
// This module provides:
//   1. `InFlightDeletionGuard` — a synchronous in-flight set keyed by document
//      id. `run(id, task)` only invokes `task` (the network call) the first
//      time an id is in flight; any concurrent `run` for the same id is a
//      no-op, so at most one DELETE is ever sent per document at a time.
//      The guard is keyed by id (not a single global flag) so multiple
//      documents can be deleted independently.
//   2. `classifyDeleteDocumentResponse` — maps a DELETE HTTP status to a stable
//      outcome so the UI knows whether to revalidate the list (2xx / 404 =
//      gone), surface a retryable error, or pass through an auth/authorization
//      failure (401/403 must never be swallowed).
//
// Framework-agnostic (no React import) so it can be unit tested in plain Node
// and reused by any Statement view.
// ---------------------------------------------------------------------------

export type DeleteRemoteResult = {
  status: number;
  ok: boolean;
};

export type DocumentDeleteOutcome =
  // Deleted by this request (2xx).
  | { kind: "deleted" }
  // Already gone (404 on the caller's own document) — treat as idempotent.
  | { kind: "gone" }
  // Transient/server failure the user can retry (5xx, network, ...).
  | { kind: "error"; message: string }
  // Auth/authorization problem (401/403, ...) that must NOT be swallowed.
  | { kind: "auth"; status: number };

/** Maps a DELETE response to a stable outcome for the UI. */
export function classifyDeleteDocumentResponse({
  status,
  ok,
}: DeleteRemoteResult): DocumentDeleteOutcome {
  if (ok) return { kind: "deleted" };
  if (status === 404) return { kind: "gone" };
  if (status === 401 || status === 403) return { kind: "auth", status };
  return { kind: "error", message: "ลบไฟล์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง" };
}

/**
 * Synchronous per-document in-flight guard.
 *
 * `run(id, task)` guarantees that while `id` is in flight, further `run` calls
 * for the same id return `{ started: false }` and NEVER invoke `task`. This is
 * the duplicate-submit prevention: even if the user clicks delete several times
 * in the same tick (before React can re-render/disable the button), only the
 * first click reaches the network.
 *
 * The guard is keyed by id, so deletes of different documents proceed
 * independently. `onStateChange` (optional) lets a caller mirror the in-flight
 * set into React state so each document's control can be disabled/pending the
 * moment its deletion begins.
 */
export class InFlightDeletionGuard {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly onStateChange?: (id: string, inFlight: boolean) => void
  ) {}

  /** True if `id` has a deletion in progress right now. */
  isInFlight(id: string): boolean {
    return this.inFlight.has(id);
  }

  /** Number of ids currently in flight. */
  get inFlightCount(): number {
    return this.inFlight.size;
  }

  /** Try to claim `id`. Returns false if it is already in flight. */
  tryBegin(id: string): boolean {
    if (this.inFlight.has(id)) return false;
    this.inFlight.add(id);
    this.onStateChange?.(id, true);
    return true;
  }

  /** Release `id`. */
  end(id: string): void {
    if (this.inFlight.delete(id)) {
      this.onStateChange?.(id, false);
    }
  }

  /**
   * Run `task` for `id` only if `id` is not already in flight.
   * `task` is invoked at most once per in-flight window.
   */
  async run<T>(
    id: string,
    task: () => Promise<T>
  ): Promise<{ started: boolean; result?: T }> {
    if (!this.tryBegin(id)) return { started: false };
    try {
      const result = await task();
      return { started: true, result };
    } finally {
      this.end(id);
    }
  }
}
