import { useEffect, useState } from "react";
import { CheckIcon, CopyIcon } from "./icons.tsx";
import { useToast } from "./Toast.tsx";

/** Put text on the clipboard; says so when the browser refuses (an insecure page, a denied permission). */
export async function copyText(text: string, toast: (message: string, kind?: "error" | "info" | "success") => void): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    toast("Clipboard unavailable; select and copy manually");
    return false;
  }
}

/**
 * Copy a whole message: at the foot of a reply, beside the speaker, and beside the user's own bubbles. A reply is
 * copied as the Markdown it was written in, so it pastes back with its formatting. A tick shows for a moment after.
 */
export function CopyTextButton({ text, label, className = "" }: { text: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const { toast } = useToast();
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  if (!text.trim()) return null;
  return (
    <button
      type="button"
      className={`small ghost icon-only copy-button${copied ? " done" : ""}${className ? ` ${className}` : ""}`}
      aria-label={copied ? "Copied" : label}
      title={copied ? "Copied" : label}
      onClick={async () => {
        if (await copyText(text, toast)) setCopied(true);
      }}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}
