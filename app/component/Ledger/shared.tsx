import type { ReactNode } from "react";
import { AlertCircle, BookOpen, RefreshCw, Search } from "lucide-react";

export function formatBaht(value: string | number | null | undefined): string {
  const n = value == null ? 0 : Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${n < 0 ? "-" : ""}฿${Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatSignedBaht(
  value: string | number | null | undefined
): string {
  const n = value == null ? 0 : Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${n >= 0 ? "+" : "-"}฿${Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function formatAmount(
  value: string | number | null | undefined
): string {
  const n = value == null ? 0 : Number(value);
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export function formatSignedAmount(
  value: string | number | null | undefined
): string {
  const n = value == null ? 0 : Number(value);
  if (!Number.isFinite(n)) return "-";
  return `${n >= 0 ? "+" : "-"}${Math.abs(n).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export function defaultPeriod(): { from: string; to: string } {
  const now = new Date();
  return {
    from: `${now.getFullYear()}-01-01`,
    to: now.toISOString().slice(0, 10),
  };
}

const ACCOUNT_TYPE_LABELS: Record<string, string> = {
  ASSET: "สินทรัพย์",
  LIABILITY: "หนี้สิน",
  EQUITY: "ส่วนทุน",
  INCOME: "รายได้",
  EXPENSE: "ค่าใช้จ่าย",
};

const ACCOUNT_TYPE_STYLES: Record<string, string> = {
  ASSET: "bg-emerald-50 text-emerald-600",
  LIABILITY: "bg-amber-50 text-amber-600",
  EQUITY: "bg-blue-50 text-blue-800",
  INCOME: "bg-green-50 text-green-600",
  EXPENSE: "bg-red-50 text-red-500",
};

export function AccountTypeBadge({ type }: { type: string }) {
  return (
    <span
      className={`inline-flex items-center text-xs font-medium px-2 py-1 rounded-full ${
        ACCOUNT_TYPE_STYLES[type] ?? "bg-gray-100 text-gray-500"
      }`}
    >
      {ACCOUNT_TYPE_LABELS[type] ?? type}
    </span>
  );
}

const SOURCE_LABELS: Record<string, string> = {
  MANUAL: "มือ",
  STATEMENT: "จาก Statement",
  AI_PARSED: "อัตโนมัติ (AI)",
};

const SOURCE_STYLES: Record<string, string> = {
  MANUAL: "bg-gray-100 text-gray-600",
  STATEMENT: "bg-blue-50 text-blue-800",
  AI_PARSED: "bg-purple-50 text-purple-700",
};

export function SourceBadge({ source }: { source: string }) {
  return (
    <span
      className={`inline-flex items-center text-xs font-medium px-2 py-1 rounded-full ${
        SOURCE_STYLES[source] ?? "bg-gray-100 text-gray-600"
      }`}
    >
      {SOURCE_LABELS[source] ?? source}
    </span>
  );
}

export function ReversedBadge() {
  return (
    <span className="inline-flex items-center text-xs font-medium px-2 py-1 rounded-full bg-gray-100 text-gray-400">
      กลับรายการแล้ว
    </span>
  );
}

interface PanelProps {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
}

export function Panel({ title, actions, children }: PanelProps) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
      {title && (
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-800">{title}</h2>
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}

export function LoadingRows() {
  return (
    <div className="px-5 py-6 space-y-3 animate-pulse">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-4">
          <div className="h-3 bg-gray-200 rounded w-24" />
          <div className="h-3 bg-gray-200 rounded w-20" />
          <div className="h-3 bg-gray-200 rounded flex-1" />
          <div className="h-3 bg-gray-200 rounded w-16" />
        </div>
      ))}
    </div>
  );
}

interface ErrorBoxProps {
  message: string;
  onRetry: () => void;
}

export function ErrorBox({ message, onRetry }: ErrorBoxProps) {
  return (
    <div className="px-5 py-10 text-center">
      <AlertCircle className="w-8 h-8 text-red-400 mx-auto mb-3" />
      <p className="text-sm font-medium text-red-600">{message}</p>
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 inline-flex items-center gap-1.5 bg-white border border-gray-200 hover:bg-gray-50 text-gray-600 text-xs font-medium px-3 py-2 rounded-lg transition"
      >
        <RefreshCw className="w-3.5 h-3.5" />
        ลองใหม่อีกครั้ง
      </button>
    </div>
  );
}

interface EmptyStateProps {
  title: string;
  hint: string;
  hintButtonLabel?: string;
  onHintClick?: () => void;
}

export function EmptyState({
  title,
  hint,
  hintButtonLabel,
  onHintClick,
}: EmptyStateProps) {
  return (
    <div className="px-5 py-12 text-center">
      <BookOpen className="w-8 h-8 text-gray-300 mx-auto mb-3" />
      <p className="text-sm font-medium text-gray-600">{title}</p>
      {hintButtonLabel && onHintClick ? (
        <button
          type="button"
          onClick={onHintClick}
          className="text-xs text-blue-800 font-medium hover:underline mt-1"
        >
          {hintButtonLabel}
        </button>
      ) : (
        <p className="text-xs text-gray-400 mt-1">{hint}</p>
      )}
    </div>
  );
}

const inputClass =
  "px-3 py-2 text-sm bg-white text-gray-900 border border-gray-200 rounded-lg outline-none focus:ring-2 focus:ring-blue-900/20 focus:border-blue-900 transition";

interface PeriodFilterProps {
  from: string;
  to: string;
  onFromChange: (value: string) => void;
  onToChange: (value: string) => void;
  onApply: () => void;
  onClear: () => void;
  asOf?: boolean;
}

export function PeriodFilter({
  from,
  to,
  onFromChange,
  onToChange,
  onApply,
  onClear,
  asOf = false,
}: PeriodFilterProps) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      <label className="block">
        <span className="block text-xs font-medium text-gray-500 mb-1.5">
          {asOf ? "ถึงวันที่" : "จากวันที่"}
        </span>
        <input
          type="date"
          value={from}
          onChange={(e) => onFromChange(e.target.value)}
          className={inputClass}
          disabled={asOf}
        />
      </label>
      {!asOf && (
        <label className="block">
          <span className="block text-xs font-medium text-gray-500 mb-1.5">
            ถึงวันที่
          </span>
          <input
            type="date"
            value={to}
            onChange={(e) => onToChange(e.target.value)}
            className={inputClass}
          />
        </label>
      )}
      <button
        type="button"
        onClick={onApply}
        className="flex items-center gap-1.5 bg-blue-900 hover:bg-blue-950 text-white text-xs font-medium px-3 py-2 rounded-lg transition"
      >
        <Search className="w-3.5 h-3.5" />
        ค้นหา
      </button>
      <button
        type="button"
        onClick={onClear}
        className="bg-white border border-gray-200 hover:bg-gray-50 text-gray-600 text-xs font-medium px-3 py-2 rounded-lg transition"
      >
        ล้าง
      </button>
    </div>
  );
}