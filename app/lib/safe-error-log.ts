// Sanitized server-side error logging.
//
// Raw Error objects can carry arbitrary string content (a DB error message
// could echo user input, a provider error could embed a request URL or header,
// bcrypt errors could embed class paths, etc.) — none of that belongs in the
// log stream for auth paths. Route catch blocks log `safeErrorLog(error)`,
// which reduces an unknown error to its stable shape and a safe error NAME
// (the constructor name, e.g. "Error"/"PostgresError") — never the message.
// We deliberately avoid printing stack/name/message strings to keep the log
// free of user-controlled and infra details; the code path is already known
// from the prefix (e.g. "Login: ...").

export interface SafeErrorLogEntry {
  errorName: string;
}

export function safeErrorLog(error: unknown): SafeErrorLogEntry {
  if (error === null) return { errorName: "null" };
  if (typeof error !== "object") return { errorName: String(typeof error) };
  const ctor = (error as { constructor?: { name?: unknown } }).constructor;
  const name = typeof ctor?.name === "string" ? ctor.name : "unknown";
  // Keep only the single-word class name; guard against hostile/odd output.
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, "").slice(0, 64);
  return { errorName: cleaned || "unknown" };
}