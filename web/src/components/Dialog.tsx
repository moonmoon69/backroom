import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "./icons.tsx";

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}

/**
 * Modal dialog: closes on Escape or backdrop click, labelled by its title. Rendered at the document body, so the
 * styles of whatever opened it (a panel head, a sidebar row) never reach into it.
 * Initial focus goes to the element marked `data-autofocus`, otherwise the first enabled field.
 * Focus is set exactly once when the dialog opens; background re-renders never move it.
 */
export function Dialog({ title, onClose, children, footer, wide }: DialogProps) {
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        closeRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const root = panel.current;
    if (!root) return;
    const preferred = root.querySelector<HTMLElement>("[data-autofocus]");
    const candidates = Array.from(root.querySelectorAll<HTMLElement>("input, textarea, select, button:not(.dialog-close)"));
    const target =
      preferred && !(preferred as HTMLInputElement).disabled
        ? preferred
        : candidates.find((element) => !(element as HTMLInputElement).disabled && element.getAttribute("type") !== "hidden");
    // Defer one frame so the browser has painted the dialog before focus moves into it.
    const frame = requestAnimationFrame(() => target?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div
        className={`dialog${wide ? " dialog-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={panel}
      >
        <div className="dialog-header">
          <h2>{title}</h2>
          <button type="button" className="dialog-close small ghost icon-only" aria-label="Close dialog" title="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>
        <div className="dialog-body">{children}</div>
        {footer ? <div className="dialog-footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}
