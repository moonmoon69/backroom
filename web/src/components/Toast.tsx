import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "./icons.tsx";

export interface Toast {
  id: number;
  kind: "error" | "info" | "success";
  message: string;
}

interface ToastApi {
  toast: (message: string, kind?: Toast["kind"]) => void;
}

const ToastContext = createContext<ToastApi>({ toast: () => {} });

export const useToast = (): ToastApi => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);
  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);
  const toast = useCallback(
    (message: string, kind: Toast["kind"] = "error") => {
      const id = ++counter.current;
      setToasts((list) => [...list, { id, kind, message }]);
      // A long message stays long enough to be read (60 ms a character), however short its kind's time.
      setTimeout(() => dismiss(id), Math.max(kind === "error" ? 8000 : 4000, message.length * 60));
    },
    [dismiss],
  );
  const value = useMemo(() => ({ toast }), [toast]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      {/* At the document body, beside the dialogs: the page under an open dialog is inert, and a toast must still be
          read out and dismissable then. */}
      {createPortal(
        <div className="toast-stack" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className={`toast toast-${t.kind}`} role={t.kind === "error" ? "alert" : "status"}>
              <span>{t.message}</span>
              <button type="button" className="small ghost icon-only" aria-label="Dismiss" title="Dismiss" onClick={() => dismiss(t.id)}>
                <CloseIcon />
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}
