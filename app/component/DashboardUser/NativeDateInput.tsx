import { useRef, type ComponentProps } from "react";
import { CalendarDays } from "lucide-react";

/** One native value/change handler for both the field and its calendar button. */
export default function NativeDateInput({ className = "", ...props }:
  Omit<ComponentProps<"input">, "type" | "ref"> & { type: "date" | "month" }) {
  const input = useRef<HTMLInputElement>(null);
  const open = () => {
    const field = input.current;
    if (!field || field.disabled || field.readOnly) return;
    field.focus();
    try { field.showPicker?.(); } catch { /* Native keyboard editing remains available. */ }
  };
  return (
    <span className="relative inline-flex items-center">
      <input {...props} ref={input} className={`${className} pr-9 [&::-webkit-calendar-picker-indicator]:hidden`}
        onClick={(event) => { props.onClick?.(event); if (!event.defaultPrevented) open(); }} />
      <button type="button" aria-label={props.type === "month" ? "เปิดปฏิทินเลือกเดือน" : "เปิดปฏิทินเลือกวันที่"}
        disabled={props.disabled || props.readOnly} onClick={open}
        className="absolute right-1 p-1 rounded hover:bg-gray-400/20 disabled:opacity-40">
        <CalendarDays className="w-4 h-4" aria-hidden="true" />
      </button>
    </span>
  );
}
