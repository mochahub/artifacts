import { X } from "lucide-preact";
import type { ComponentChildren } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";

export function Sheet({
  title,
  subtitle,
  onClose,
  children,
  extra,
}: {
  title: string;
  /** Where the sheet's subject lives, under the title: a page or a frame. */
  subtitle?: string;
  onClose(): void;
  children: ComponentChildren;
  extra?: ComponentChildren;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  // As the sheet appears, not a frame later, so a quick Escape still closes it.
  useLayoutEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [onClose]);
  // Focus goes into the sheet, unless something inside already took it, and back to what opened it.
  useLayoutEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    if (dialog.current && !dialog.current.contains(document.activeElement)) {
      dialog.current.focus({ preventScroll: true });
    }
    return () => {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);
  return (
    <>
      <div class="dim" onClick={onClose} aria-hidden="true" />
      <div class="sheet" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={dialog}>
        <div class="grabber" />
        <div class="shead">
          <div class="t">
            {title}
            {subtitle && <span class="fn">{subtitle}</span>}
          </div>
          {extra}
          <button type="button" class="x" aria-label="Close" onClick={onClose}>
            <X />
          </button>
        </div>
        {children}
      </div>
    </>
  );
}
