import { useLayoutEffect, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { MOBILE_QUERY, useMediaQuery } from "../useMediaQuery.ts";

interface PopoverProps {
  /** The element the menu hangs from on desktop. */
  anchor: RefObject<HTMLElement | null>;
  /** Ref to the rendered menu, so the owner's outside-click check can include it. */
  menuRef: RefObject<HTMLDivElement | null>;
  className?: string;
  role?: string;
  onClose: () => void;
  children: ReactNode;
}

/**
 * A menu rendered at the document body, so no scrolling or overflow-clipped ancestor (the side panel, a
 * drawer) can cut it off and it never stretches the row it belongs to. On desktop it sits just below its
 * anchor, kept inside the viewport; on phones it is a bottom sheet behind a tap-to-dismiss backdrop.
 */
export function Popover({ anchor, menuRef, className, role, onClose, children }: PopoverProps) {
  const sheet = useMediaQuery(MOBILE_QUERY);
  const [style, setStyle] = useState<CSSProperties>({ visibility: "hidden" });

  useLayoutEffect(() => {
    if (sheet) {
      setStyle({});
      return;
    }
    const place = () => {
      const target = anchor.current;
      const menu = menuRef.current;
      if (!target || !menu) return;
      const rect = target.getBoundingClientRect();
      const margin = 8;
      const width = menu.offsetWidth;
      const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
      const top = rect.bottom + 4;
      setStyle({ top, left, maxHeight: Math.max(160, window.innerHeight - top - margin) });
    };
    place();
    window.addEventListener("resize", place);
    // Scrolling anywhere (the side panel, the page) moves the anchor; capture catches every scroller.
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [sheet, anchor, menuRef]);

  const menu = (
    <div ref={menuRef} className={`menu popover${sheet ? " popover-sheet" : ""}${className ? ` ${className}` : ""}`} role={role} style={style}>
      {children}
    </div>
  );
  return createPortal(
    sheet ? (
      <>
        <div className="popover-backdrop" onClick={onClose} aria-hidden="true" />
        {menu}
      </>
    ) : (
      menu
    ),
    document.body,
  );
}
