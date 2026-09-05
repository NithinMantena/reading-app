import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

interface Toast { id: number; text: string; kind: "info" | "error" }
interface ToastApi { notify: (text: string) => void; fail: (err: unknown, fallback?: string) => void }

const Ctx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((text: string, kind: Toast["kind"]) => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs, { id, text, kind }]);
    window.setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), kind === "error" ? 7000 : 3500);
  }, []);
  const api = useMemo<ToastApi>(
    () => ({
      notify: (t) => push(t, "info"),
      fail: (e, fallback = "Something went wrong") => push(e instanceof Error && e.message ? e.message : fallback, "error"),
    }),
    [push],
  );
  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind === "error" ? "error" : ""}`}>
            <span>{t.text}</span>
            <button onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))} aria-label="Dismiss">×</button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast(): ToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error("useToast outside ToastProvider");
  return v;
}
