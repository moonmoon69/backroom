import { useEffect, useRef, useState } from "react";
import type { LiveFeedItem } from "../types.ts";
import { Markdown } from "./Markdown.tsx";

const COLLAPSED_ITEMS = 8;

/**
 * The running turn as T3 shows it: each assistant message as its own block (progress notes between tool calls,
 * then the final answer), with the tool calls between them collapsed to one line per burst (naming the ones still
 * running), and a line when the context is compacted. The newest message
 * is emphasized; the view follows the newest item unless the user scrolled up.
 */
export function LiveFeed({ items, placeholder, className }: { items: LiveFeedItem[]; placeholder: string; className?: string }) {
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const [expanded, setExpanded] = useState(false);

  const hidden = expanded ? 0 : Math.max(0, items.length - COLLAPSED_ITEMS);
  const shown = items.slice(hidden);
  let latestMessage = -1;
  shown.forEach((item, index) => {
    if (item.kind === "message") latestMessage = index;
  });

  const last = items[items.length - 1];
  const signature = `${items.length}:${last?.at ?? ""}:${last?.kind === "message" ? last.text.length : last?.kind === "tools" ? `${last.count}/${last.running.length}` : (last?.text ?? "")}`;
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [signature]);

  const classes = `live-feed${className ? ` ${className}` : ""}`;
  if (items.length === 0) return <div className={`${classes} live-empty muted`}>{placeholder}</div>;

  return (
    <div
      className={classes}
      ref={scroller}
      onScroll={() => {
        const el = scroller.current;
        if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
      }}
    >
      {hidden > 0 || expanded ? (
        <button type="button" className="status-toggle mono live-more" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? "show recent only" : `+${hidden} earlier`}
        </button>
      ) : null}
      {shown.map((item, index) =>
        item.kind === "message" ? (
          <div key={item.id} className={`live-message${index === latestMessage ? " latest" : ""}${item.streaming ? " streaming" : ""}`}>
            <Markdown text={item.text} />
          </div>
        ) : item.kind === "notice" ? (
          <div key={item.id} className={`live-tools live-notice mono${item.active ? " active" : ""}`}>
            {item.text}
          </div>
        ) : (
          <div key={`tools-${hidden + index}`} className={`live-tools mono${item.errors > 0 ? " has-errors" : ""}${item.running.length > 0 ? " active" : ""}`}>
            {item.running.length > 0 ? <span className="live-tool-running">running {item.running.join(", ")}</span> : null}
            {item.running.length > 0 && item.count > item.running.length ? " · " : null}
            {item.count > item.running.length || item.running.length === 0 ? (
              <>
                ran {item.count - item.running.length} tool{item.count - item.running.length === 1 ? "" : "s"}
                {item.labels.length > 0 ? <span className="live-tool-labels"> · {item.labels.join(", ")}</span> : null}
              </>
            ) : null}
            {item.errors > 0 ? <span className="status-error"> · {item.errors} failed</span> : null}
          </div>
        ),
      )}
    </div>
  );
}
