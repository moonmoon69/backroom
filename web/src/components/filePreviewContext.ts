/** Who opens a file's preview, and where a reply's relative paths are looked for first (see FilePreview.tsx). */
import { createContext, useContext } from "react";

export interface FilePreviewRequest {
  /** As the reply wrote it: relative (to `base`, else to a project) or absolute. */
  path: string;
  line?: number | undefined;
  /** Last line of a range the reply named. */
  endLine?: number | undefined;
  base: string | null;
}

export interface ImagePreviewRequest {
  /** Already resolved for display; never sent to the filesystem preview API. */
  src: string;
  alt: string;
  title?: string | undefined;
}

/** The folder a reply was written in (its member's worktree or project folder). */
export const FileBaseContext = createContext<string | null>(null);

/** Opens a preview; null outside the app, where a file chip copies its path instead. */
export const FilePreviewContext = createContext<((request: FilePreviewRequest) => void) | null>(null);
export const ImagePreviewContext = createContext<((request: ImagePreviewRequest) => void) | null>(null);

export const useFileBase = (): string | null => useContext(FileBaseContext);
export const useOpenFilePreview = (): ((request: FilePreviewRequest) => void) | null => useContext(FilePreviewContext);
export const useOpenImagePreview = (): ((request: ImagePreviewRequest) => void) | null => useContext(ImagePreviewContext);
