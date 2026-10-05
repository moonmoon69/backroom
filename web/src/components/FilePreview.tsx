/**
 * The file preview: a file chip in a reply (`web/src/App.tsx:42`, `docs/plan.md`) opens the file in a dialog. Markdown
 * is rendered (or shown as source), code is highlighted with line numbers and scrolled to the line named, images,
 * recordings and sounds are shown, and a document can be read aloud. The service decides what may be read; see
 * src/server/filePreview.ts.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api } from "../api.ts";
import { highlightCode } from "../highlight.ts";
import type { FilePreviewResponse } from "../types.ts";
import { CopyTextButton } from "./CopyText.tsx";
import { Dialog } from "./Dialog.tsx";
import { FileBaseContext, FilePreviewContext, type FilePreviewRequest } from "./filePreviewContext.ts";
import { Markdown } from "./Markdown.tsx";
import { fileBadge, parseFileReference } from "./markdownFiles.ts";
import { SpeakButton } from "./SpeakButton.tsx";

/** Makes file chips open previews for everything under it, and shows the preview asked for. */
export function FilePreviewHost({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<FilePreviewRequest | null>(null);
  return (
    <FilePreviewContext.Provider value={setRequest}>
      {children}
      {request ? <FilePreviewDialog key={`${request.base ?? ""}\n${request.path}\n${request.line ?? ""}-${request.endLine ?? ""}`} request={request} onClose={() => setRequest(null)} /> : null}
    </FilePreviewContext.Provider>
  );
}

const baseName = (path: string): string => path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1) || path;
const folderOf = (path: string): string => path.slice(0, Math.max(path.lastIndexOf("/"), 1));
const isMarkdown = (name: string): boolean => /\.(md|mdx|markdown)$/i.test(name);
/** Documents worth reading aloud: prose, not code. */
const isReadable = (name: string): boolean => isMarkdown(name) || /\.(txt|text|rst|adoc)$/i.test(name) || !name.includes(".");
const sizeOf = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

function FilePreviewDialog({ request, onClose }: { request: FilePreviewRequest; onClose: () => void }) {
  const [state, setState] = useState<{ preview: FilePreviewResponse } | { error: string } | null>(null);
  const [source, setSource] = useState(false);
  useEffect(() => {
    let cancelled = false;
    api.filePreview(request.path, request.base).then(
      (preview) => !cancelled && setState({ preview }),
      (caught: unknown) => !cancelled && setState({ error: caught instanceof Error ? caught.message : String(caught) }),
    );
    return () => {
      cancelled = true;
    };
  }, [request]);
  const name = baseName(request.path);
  const preview = state && "preview" in state ? state.preview : null;
  const path = preview?.path ?? request.path;
  const badge = fileBadge(parseFileReference(name) ?? { raw: name, path: name, basename: name, extension: name.includes(".") ? name.slice(name.lastIndexOf(".") + 1).toLowerCase() : "" });
  const text = preview?.kind === "text" ? preview.content : null;
  const markdown = text !== null && isMarkdown(name);

  let body: ReactNode;
  if (!state) body = <p className="muted mono">Opening…</p>;
  else if ("error" in state) body = <p className="status-error">{state.error}</p>;
  else if (state.preview.kind === "binary") body = <p className="muted">A binary file ({sizeOf(state.preview.size)}): nothing to show as text.</p>;
  else if (state.preview.kind !== "text") {
    const { kind, url } = state.preview;
    body = kind === "image" ? <img className="file-media" src={url} alt={name} /> : kind === "video" ? <video className="file-media" src={url} controls preload="metadata" /> : <audio className="file-media" src={url} controls preload="metadata" />;
  } else if (markdown && !source) {
    // Paths in a document are looked for next to it first, then in the projects.
    body = (
      <FileBaseContext.Provider value={folderOf(path)}>
        <div className="file-doc">
          <Markdown text={state.preview.content} />
        </div>
      </FileBaseContext.Provider>
    );
  } else body = <CodeView code={state.preview.content} fileName={name} line={request.line} endLine={request.endLine} />;

  return (
    <Dialog title={name} onClose={onClose} large>
      <div className="file-preview">
        <div className="file-preview-bar">
          <span className={`md-file-badge tone-${badge.tone}`} aria-hidden="true">
            {badge.label}
          </span>
          <span className="file-preview-path mono" title={path}>
            <bdi>
              {path}
              {request.line !== undefined ? `:${request.line}${request.endLine !== undefined ? `-${request.endLine}` : ""}` : ""}
            </bdi>
          </span>
          {preview && preview.kind !== "binary" ? <span className="file-preview-size mono">{sizeOf(preview.size)}</span> : null}
          <span className="spacer" />
          {markdown ? (
            <span className="segmented file-preview-mode" role="group" aria-label="Show">
              <button type="button" className={`segment${source ? "" : " on"}`} aria-pressed={!source} onClick={() => setSource(false)}>
                Rendered
              </button>
              <button type="button" className={`segment${source ? " on" : ""}`} aria-pressed={source} onClick={() => setSource(true)}>
                Source
              </button>
            </span>
          ) : null}
          {text !== null && isReadable(name) ? <SpeakButton id={`file:${path}`} text={text} lead={name} /> : null}
          <CopyTextButton text={path} label="Copy path" />
        </div>
        <div className="file-preview-body">{body}</div>
        {preview?.kind === "text" && preview.truncated ? <p className="muted file-preview-note">Showing the first 512 KB of {sizeOf(preview.size)}.</p> : null}
      </div>
    </Dialog>
  );
}

/** Code (or plain text) with line numbers, highlighted once Shiki has loaded; the lines named are marked and in view. */
function CodeView({ code, fileName, line, endLine = line }: { code: string; fileName: string; line?: number | undefined; endLine?: number | undefined }) {
  // A file's last newline ends its last line; it does not start another.
  const text = code.endsWith("\n") ? code.slice(0, -1) : code;
  const [html, setHtml] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let cancelled = false;
    void highlightCode(text, fileName, line, endLine).then((result) => !cancelled && setHtml(result));
    return () => {
      cancelled = true;
    };
  }, [text, fileName, line, endLine]);
  useEffect(() => {
    if (line !== undefined) box.current?.querySelector(".line.target")?.scrollIntoView({ block: "center" });
  }, [html, line]);
  const lines = text.split("\n");
  return (
    <div className="file-code" ref={box}>
      {html ? (
        <div dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <pre className="shiki plain">
          <code>
            {lines.map((text, index) => (
              <span key={index} className={`line${line !== undefined && endLine !== undefined && index + 1 >= line && index + 1 <= endLine ? " target" : ""}`}>
                {text}
              </span>
            ))}
          </code>
        </pre>
      )}
    </div>
  );
}
