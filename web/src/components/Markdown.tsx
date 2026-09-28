import { memo, useEffect, useRef, useState, type ComponentProps, type JSX, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { copyText } from "./CopyText.tsx";
import { useToast } from "./Toast.tsx";
import { fileBadge, imageSource, isLocalPath, mediaKind, parseFileReference } from "./markdownFiles.ts";

type MdProps<T extends keyof JSX.IntrinsicElements> = ComponentProps<T> & { node?: unknown };

/**
 * Fenced code block with a copy button that appears on hover (or keyboard focus). The text is read
 * from the rendered element so it matches exactly what the reader sees, including nested markup.
 */
function CodeBlock({ node: _node, children, ...props }: MdProps<"pre">) {
  const pre = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    const text = (pre.current?.textContent ?? "").replace(/\n$/, "");
    if (await copyText(text, toast)) setCopied(true);
  };

  return (
    <div className="md-code">
      <pre ref={pre} {...props}>
        {children}
      </pre>
      <button
        type="button"
        className={`md-copy${copied ? " md-copy-done" : ""}`}
        aria-label={copied ? "Copied" : "Copy code"}
        title="Copy code"
        onClick={copy}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

const textOf = (children: ReactNode): string | null => {
  if (typeof children === "string") return children;
  if (Array.isArray(children) && children.every((child) => typeof child === "string")) return children.join("");
  return null;
};

/**
 * Inline code: when it names a file (`web/src/App.tsx:42`), render T3 Code's style of file chip, showing the
 * basename with a type badge and the full path as a tooltip. Fenced blocks carry a trailing newline from
 * remark, which is how they are told apart here; everything else stays a plain <code>.
 */
function Code({ node: _node, children, className, ...props }: MdProps<"code">) {
  const { toast } = useToast();
  const text = textOf(children);
  const reference = text !== null && !text.includes("\n") && !className ? parseFileReference(text) : null;
  if (!reference) {
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  }
  const badge = fileBadge(reference);
  const location = reference.line !== undefined ? `:${reference.line}${reference.column !== undefined ? `:${reference.column}` : ""}` : "";
  return (
    <button
      type="button"
      className="md-file"
      title={`${reference.raw}\nClick to copy path`}
      onClick={async () => {
        if (await copyText(reference.raw, toast)) toast("Copied path", "success");
      }}
    >
      <span className={`md-file-badge tone-${badge.tone}`} aria-hidden="true">
        {badge.label}
      </span>
      <span className="md-file-name">
        {reference.basename}
        {location ? <span className="md-file-loc">{location}</span> : null}
      </span>
    </button>
  );
}

/**
 * Embedded files: markdown writes them all as images, but a local path may be a recording or a sound as well. Local
 * paths are served by the service; a video or audio file gets a player, an image a frame that links to the full size.
 */
function Image({ node: _node, src, alt, title, ...props }: MdProps<"img">) {
  const [broken, setBroken] = useState(false);
  const resolved = typeof src === "string" ? imageSource(src) : "";
  if (!resolved) return null;
  const kind = typeof src === "string" ? mediaKind(src) : "image";
  if (broken) {
    return (
      <span className="md-img-broken" title={typeof src === "string" ? src : undefined}>
        <span aria-hidden="true">{kind === "image" ? "🖼" : kind === "video" ? "🎬" : "🔊"}</span>
        {alt || (typeof src === "string" ? src : kind)} (unavailable)
      </span>
    );
  }
  if (kind === "video") {
    return (
      <span className="md-media">
        <video className="md-video" controls playsInline preload="metadata" src={resolved} title={title ?? alt ?? undefined} onError={() => setBroken(true)} />
        {alt ? <span className="md-media-caption">{alt}</span> : null}
      </span>
    );
  }
  if (kind === "audio") {
    return (
      <span className="md-media">
        <audio className="md-audio" controls preload="metadata" src={resolved} title={title ?? alt ?? undefined} onError={() => setBroken(true)} />
        {alt ? <span className="md-media-caption">{alt}</span> : null}
      </span>
    );
  }
  return (
    <a className="md-img" href={resolved} target="_blank" rel="noopener noreferrer" title={title ?? (typeof src === "string" ? src : undefined)}>
      <img {...props} src={resolved} alt={alt ?? ""} loading="lazy" onError={() => setBroken(true)} />
    </a>
  );
}

/**
 * Participant replies as GitHub-flavoured markdown. Raw HTML is never rendered (no rehype-raw), and
 * react-markdown's default URL transform drops javascript: and similar links; file: URLs are kept so
 * local screenshots can be mapped to the room server's image route.
 */
const components: Components = {
  // A link to a media file on the machine opens it through the service, like an embedded one.
  a: ({ node: _node, href, ...props }: MdProps<"a">) => <a {...props} href={typeof href === "string" && isLocalPath(href) && /\.(png|jpe?g|gif|webp|svg|bmp|avif|mp4|m4v|webm|mov|ogv|wav|mp3|m4a|aac|ogg|oga|flac)$/i.test(href) ? imageSource(href) : href} target="_blank" rel="noopener noreferrer" />,
  // Wide GitHub tables scroll inside the bubble instead of stretching it.
  table: ({ node: _node, ...props }: MdProps<"table">) => (
    <div className="md-table">
      <table {...props} />
    </div>
  ),
  pre: CodeBlock,
  code: Code,
  img: Image,
};

const urlTransform = (url: string): string => (url.startsWith("file://") ? url : defaultUrlTransform(url));

const plugins = [remarkGfm];

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={`md${className ? ` ${className}` : ""}`}>
      <ReactMarkdown remarkPlugins={plugins} components={components} urlTransform={urlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
