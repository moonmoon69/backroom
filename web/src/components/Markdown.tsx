import { memo, useEffect, useRef, useState, type ComponentProps, type JSX, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform, type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { copyText } from "./CopyText.tsx";
import { useFileBase, useOpenFilePreview, useOpenImagePreview } from "./filePreviewContext.ts";
import { useToast } from "./Toast.tsx";
import { fileBadge, headingAnchor, imageSource, isDataImage, isImageLink, isLocalPath, linkTarget, mediaKind, parseFileReference } from "./markdownFiles.ts";

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
 * basename with a type badge and the full path as a tooltip. A click opens the file's preview (FilePreview.tsx),
 * looked for from the folder the reply was written in. Fenced blocks carry a trailing newline from remark, which is
 * how they are told apart here; everything else stays a plain <code>.
 */
function Code({ node: _node, children, className, ...props }: MdProps<"code">) {
  const { toast } = useToast();
  const openPreview = useOpenFilePreview();
  const base = useFileBase();
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
  const location = reference.line !== undefined ? `:${reference.line}${reference.endLine !== undefined ? `-${reference.endLine}` : reference.column !== undefined ? `:${reference.column}` : ""}` : "";
  return (
    <button
      type="button"
      className="md-file"
      title={openPreview ? `${reference.raw}\nClick to preview` : `${reference.raw}\nClick to copy path`}
      onClick={async () => {
        if (openPreview) return openPreview({ path: reference.path, line: reference.line, endLine: reference.endLine, base });
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
 * paths are served by the service; a video or audio file gets a player, an image opens the preview surface.
 */
function Image({ node: _node, src, alt, title, ...props }: MdProps<"img">) {
  const [broken, setBroken] = useState(false);
  const base = useFileBase();
  const openImage = useOpenImagePreview();
  const resolved = typeof src === "string" ? imageSource(src, base) : "";
  useEffect(() => setBroken(false), [resolved]);
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
  const image = <img {...props} src={resolved} alt={alt ?? ""} loading="lazy" onError={() => setBroken(true)} />;
  if (openImage) return (
    <button type="button" className="md-img image-preview-trigger" aria-label={`Open image: ${alt || title || "picture"}`} aria-haspopup="dialog" title={title ?? (typeof src === "string" ? src : undefined)} onClick={() => openImage({ src: resolved, alt: alt ?? "", title })}>
      {image}
    </button>
  );
  return (
    <a className="md-img" href={resolved} target="_blank" rel="noopener noreferrer" title={title ?? (typeof src === "string" ? src : undefined)}>
      {image}
    </a>
  );
}

/** The text of a markdown node (a heading with code or emphasis in it), as GitHub reads it for its anchor. */
const textOfNode = (node: unknown): string => {
  const element = node as { type?: string; value?: string; children?: unknown[] } | undefined;
  if (!element) return "";
  if (element.type === "text") return element.value ?? "";
  return (element.children ?? []).map(textOfNode).join("");
};

/** A heading that the text's own links can reach: `#how-it-works` scrolls to "How it works". */
function heading(Tag: "h1" | "h2" | "h3" | "h4" | "h5" | "h6") {
  return function Heading({ node, ...props }: MdProps<typeof Tag>) {
    return <Tag {...props} data-anchor={headingAnchor(textOfNode(node))} />;
  };
}

/**
 * Links go where they point without leaving the app: `#…` scrolls to that heading of the same text, a file on the
 * machine (relative to the text's folder, absolute, or file://) opens its preview, and only the web opens a new tab.
 */
function Link({ node, href, children, ...props }: MdProps<"a">) {
  const openPreview = useOpenFilePreview();
  const openImage = useOpenImagePreview();
  const base = useFileBase();
  const target = typeof href === "string" && href ? linkTarget(href) : { kind: "web" as const };
  // A linked picture already supplies its own button. Remove the outer navigation and nested interactive control.
  const containsPicture = (value: unknown): boolean => {
    const element = value as { tagName?: string; children?: unknown[] } | undefined;
    return element?.tagName === "img" || (element?.children ?? []).some(containsPicture);
  };
  if (openImage && containsPicture(node)) return <span title={props.title}>{children}</span>;
  if (openImage && href && isImageLink(href)) {
    const imageHref = target.kind === "file" ? target.path : href;
    return <a {...props} href={href} aria-haspopup="dialog" onClick={(event) => {
      event.preventDefault();
      openImage({ src: imageSource(imageHref, base), alt: textOfNode(node), title: props.title });
    }}>{children}</a>;
  }
  if (target.kind === "anchor") {
    return (
      <a
        {...props}
        href={href}
        onClick={(event) => {
          event.preventDefault();
          const root = event.currentTarget.closest(".md");
          const heading = root?.querySelector(`[data-anchor="${CSS.escape(target.anchor.toLowerCase())}"]`);
          if (!root || !heading) return;
          const reveal = () => heading.scrollIntoView({ block: "start" });
          reveal();
          // Pictures load as they come into view and push the heading down; keep it at the top while they do.
          const loading = [...root.querySelectorAll("img")].filter((image) => !image.complete);
          for (const image of loading) image.addEventListener("load", reveal, { once: true });
          setTimeout(() => loading.forEach((image) => image.removeEventListener("load", reveal)), 3000);
        }}
      >
        {children}
      </a>
    );
  }
  if (target.kind === "file" && openPreview) {
    return (
      <a
        {...props}
        href={href}
        onClick={(event) => {
          event.preventDefault();
          openPreview({ path: target.path, line: target.line, endLine: target.endLine, base });
        }}
      >
        {children}
      </a>
    );
  }
  // Outside the app a file link can only be fetched: a media file through the service, like an embedded one.
  const media = typeof href === "string" && isLocalPath(href) && /\.(png|jpe?g|gif|webp|svg|bmp|avif|mp4|m4v|webm|mov|ogv|wav|mp3|m4a|aac|ogg|oga|flac)$/i.test(href);
  return (
    <a {...props} href={media ? imageSource(href, base) : href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  );
}

/**
 * Participant replies as GitHub-flavoured markdown. Raw HTML is never rendered (no rehype-raw), and
 * react-markdown's default URL transform drops javascript: and similar links; file: URLs are kept so
 * local screenshots can be mapped to the room server's image route.
 */
const components: Components = {
  a: Link,
  h1: heading("h1"),
  h2: heading("h2"),
  h3: heading("h3"),
  h4: heading("h4"),
  h5: heading("h5"),
  h6: heading("h6"),
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

const urlTransform = (url: string): string => (url.startsWith("file://") || isDataImage(url) ? url : defaultUrlTransform(url));

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
