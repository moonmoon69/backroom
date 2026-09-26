/**
 * A page's ⋯ menu: an icon button that opens a short list of actions, the dangerous one last and in red. Used where
 * a header would otherwise grow a row of text buttons.
 */
import { useEffect, useRef, useState } from "react";
import { MoreIcon } from "./icons.tsx";
import { Popover } from "./Popover.tsx";

export interface OptionsMenuItem {
  label: string;
  onPick: () => void;
  title?: string;
  danger?: boolean;
}

export function OptionsMenu({ label, items }: { label: string; items: OptionsMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!anchor.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        className={`small ghost icon-only${open ? " active" : ""}`}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreIcon />
      </button>
      {open ? (
        <Popover anchor={anchor} menuRef={menuRef} role="menu" onClose={() => setOpen(false)}>
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={item.danger ? "danger" : undefined}
              title={item.title}
              onClick={() => {
                setOpen(false);
                item.onPick();
              }}
            >
              {item.label}
            </button>
          ))}
        </Popover>
      ) : null}
    </>
  );
}
