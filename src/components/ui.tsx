import { useEffect, useRef, type ReactNode } from "react";
import type { AccessClass, LibraryStatus, QueueStatus } from "../lib/types";
import { ACCESS_LABEL, LIBRARY_STATUS_LABEL, QUEUE_STATUS_LABEL } from "../lib/format";

export function Modal({ open, title, onClose, children, footer }: {
  open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog ref={ref} className="modal" onClose={onClose} onCancel={(e) => { e.preventDefault(); onClose(); }} aria-label={title}>
      {open && (
        <>
          <div className="modal-head">
            <h2>{title}</h2>
            <button className="btn ghost sm" onClick={onClose} aria-label="Close">✕</button>
          </div>
          <div className="modal-body">{children}</div>
          {footer && <div className="modal-foot">{footer}</div>}
        </>
      )}
    </dialog>
  );
}

export function Badge({ children, tone = "" }: { children: ReactNode; tone?: "" | "green" | "blue" | "amber" | "red" | "accent" }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function StatusBadge({ status }: { status: LibraryStatus }) {
  const tone = status === "reading" ? "blue" : status === "finished" ? "green" : status === "stopped" ? "amber" : "";
  return <Badge tone={tone}>{LIBRARY_STATUS_LABEL[status]}</Badge>;
}

export function QueueBadge({ status }: { status: QueueStatus }) {
  const tone = status === "reading" ? "blue" : status === "finished" ? "green" : status === "archived" ? "amber" : "";
  return <Badge tone={tone}>{QUEUE_STATUS_LABEL[status]}</Badge>;
}

export function AccessBadge({ access }: { access: AccessClass }) {
  const tone = access === "free_full_text" || access === "open_copy" ? "green" : access === "nyt_subscription" ? "blue" : access === "unknown" ? "amber" : "red";
  return <Badge tone={tone}>{ACCESS_LABEL[access]}</Badge>;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      {children && <div className="small">{children}</div>}
    </div>
  );
}

/** 0–10 with one decimal; blank means unrated (distinct from 0). */
export function RatingInput({ value, onChange, id }: { value: number | null; onChange: (v: number | null) => void; id?: string }) {
  return (
    <div className="row">
      <input
        id={id}
        type="number"
        min={0}
        max={10}
        step={0.1}
        inputMode="decimal"
        placeholder="Unrated"
        style={{ width: 110 }}
        value={value ?? ""}
        onChange={(e) => {
          const raw = e.target.value;
          if (raw === "") return onChange(null);
          const n = Number(raw);
          if (Number.isNaN(n)) return;
          onChange(Math.min(10, Math.max(0, Math.round(n * 10) / 10)));
        }}
      />
      <span className="hint">0–10, one decimal. Blank = unrated.</span>
    </div>
  );
}

export function ChipsInput({ values, onChange, placeholder = "Add and press Enter" }: {
  values: string[]; onChange: (v: string[]) => void; placeholder?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const add = () => {
    const v = ref.current?.value.trim();
    if (!v) return;
    if (!values.includes(v)) onChange([...values, v]);
    if (ref.current) ref.current.value = "";
  };
  return (
    <div className="stack" style={{ gap: "0.4rem" }}>
      <div className="chips">
        {values.map((v) => (
          <span className="chip" key={v}>
            {v}
            <button type="button" aria-label={`Remove ${v}`} onClick={() => onChange(values.filter((x) => x !== v))}>×</button>
          </span>
        ))}
      </div>
      <input
        ref={ref}
        type="text"
        placeholder={placeholder}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); }
        }}
        onBlur={add}
      />
    </div>
  );
}
