import { useRef, type ComponentProps } from "react";

/** Native field; clicking the field itself opens the browser date/month picker. */
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
    <span className="inline-flex items-center">
      <input {...props} ref={input} className={className}
        onClick={(event) => { props.onClick?.(event); if (!event.defaultPrevented) open(); }} />
    </span>
  );
}
