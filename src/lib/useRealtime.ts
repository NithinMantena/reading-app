import { useEffect } from "react";
import { supabase, isConfigured } from "./supabase";

/**
 * Re-run `onChange` whenever any of the given tables changes for this owner. Realtime
 * is delivered through Supabase; RLS ensures only owner rows are visible. Falls back to
 * a slow poll so a bot write is reflected within a few seconds even if the socket drops.
 */
export function useRealtime(tables: string[], onChange: () => void, pollMs = 15000): void {
  useEffect(() => {
    if (!isConfigured) return;
    let timer: number | undefined;
    const channel = supabase.channel(`rt-${tables.join("-")}-${Math.random().toString(36).slice(2)}`);
    for (const t of tables) {
      channel.on("postgres_changes", { event: "*", schema: "public", table: t }, () => onChange());
    }
    channel.subscribe();
    if (pollMs > 0) timer = window.setInterval(onChange, pollMs);
    const onFocus = () => onChange();
    window.addEventListener("focus", onFocus);
    return () => {
      supabase.removeChannel(channel);
      if (timer) window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables.join(","), onChange]);
}
