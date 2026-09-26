import { useLayoutEffect, useState, type CSSProperties, type HTMLAttributes, type ReactNode, type RefObject } from "react";
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
  /** As wide as the anchor (a list under a full-width field), rather than as wide as the menu's content. */
  matchAnchorWidth?: boolean;
  /** Other attributes for the menu element (id, aria-*, tabIndex, key handlers). */
  menuProps?: HTMLAttributes<HTMLDivElement>;
}

/**
 * A menu rendered at the document body, so no scrolling or overflow-clipped ancestor (the side panel, a
 * drawer, a dialog) can cut it off and it never stretches the row it belongs to. On desktop it sits just below its
 * anchor, or above it when it fits better there, kept inside the viewport; on phones it is a bottom sheet behind a
 * tap-to-dismiss backdrop.
 */
export function Popover({ anchor, menuRef, className, role, onClose, children, matchAnchorWidth, menuProps }: PopoverProps) {
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
      const width = matchAnchorWidth ? rect.width : menu.offsetWidth;
      const left = Math.max(margin, Math.min(rect.left, window.innerWidth - width - margin));
      const below = window.innerHeight - rect.bottom - 4 - margin;
      const above = rect.top - 4 - margin;
      const sized = matchAnchorWidth ? { width } : {};
      // Below unless the menu doesn't fit there and there is more room above.
      if (menu.scrollHeight <= below || below >= above) setStyle({ top: rect.bottom + 4, left, maxHeight: Math.max(160, below), ...sized });
      else setStyle({ bottom: window.innerHeight - rect.top + 4, left, maxHeight: above, ...sized });
    };
    place();
    window.addEventListener("resize", place);
    // Scrolling anywhere (the side panel, the page) moves the anchor; capture catches every scroller.
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [sheet, anchor, menuRef, matchAnchorWidth]);

  const menu = (
    <div {...menuProps} ref={menuRef} className={`menu popover${sheet ? " popover-sheet" : ""}${className ? ` ${className}` : ""}`} role={role} style={style}>
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
