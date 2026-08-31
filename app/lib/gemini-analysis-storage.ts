// Client-only session-scoped store for the latest VALIDATED Gemini structured
// analysis returned by the server upload endpoint. Used so the result survives
// navigation from the Dashboard uploader to the FX/AI page within this browser
// session, without creating a new DB table.
//
// Only server-validated results (`source: "gemini"`) are ever stored. Error /
// unavailable results are never persisted, and the store is cleared on them so
// a stale success is never presented. This module never sees the API key.
import type { AiResult } from "./ai-result";

export const GEMINI_LATEST_ANALYSIS_KEY = "stax_latest_gemini_analysis";

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function getSessionStorage(): KeyValueStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function isValidGeminiAnalysis(
  value: unknown
): value is Extract<AiResult, { source: "gemini" }> {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.source !== "gemini" || v.code !== null) return false;
  const result = v.result as Record<string, unknown> | undefined;
  const statement = result?.statement as Record<string, unknown> | undefined;
  return (
    typeof statement === "object" &&
    statement !== null &&
    Array.isArray(statement.transactions)
  );
}

/**
 * Store the latest validated Gemini analysis for this browser session.
 * A success replaces the previous value; an error/unavailable result clears the
 * store so it can never be shown as a successful analysis.
 */
export function saveLatestGeminiAnalysis(
  ai: AiResult,
  storage: KeyValueStorage | null = getSessionStorage()
): void {
  if (!storage) return;
  try {
    if (ai.source === "gemini") {
      storage.setItem(GEMINI_LATEST_ANALYSIS_KEY, JSON.stringify(ai));
    } else {
      storage.removeItem(GEMINI_LATEST_ANALYSIS_KEY);
    }
  } catch {
    // Storage unavailable: best-effort only, never break the upload flow.
  }
}

/** Read the latest validated Gemini analysis, or null when absent/invalid. */
export function loadLatestGeminiAnalysis(
  storage: KeyValueStorage | null = getSessionStorage()
): Extract<AiResult, { source: "gemini" }> | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(GEMINI_LATEST_ANALYSIS_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isValidGeminiAnalysis(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}