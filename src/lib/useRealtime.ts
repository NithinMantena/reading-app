import { useEffect } from "react";
import { supabase, isConfigured } from "./supabase";

/**
 * Re-run `onChange` whenever any of the given tables changes for this owner. Realtime
 * is delivered through Supabase; RLS ensures only owner rows are visible. Falls back to
 * a slow poll so a bot write is reflected even if the socket drops. Refreshes run in the
 * background against the cache, so they never blank the page. Nothing polls while the
 * tab is hidden; a refresh runs once it becomes visible again.
 */
export function useRealtime(tables: string[], onChange: () => void, pollMs = 30000): void {
  useEffect(() => {
    if (!isConfigured) return;
    let timer: number | undefined;
    const channel = supabase.channel(`rt-${tables.join("-")}-${Math.random().toString(36).slice(2)}`);
    for (const t of tables) {
      channel.on("postgres_changes", { event: "*", schema: "public", table: t }, () => onChange());
    }
    channel.subscribe();
    if (pollMs > 0) timer = window.setInterval(() => { if (document.visibilityState === "visible") onChange(); }, pollMs);
    const onVisible = () => { if (document.visibilityState === "visible") onChange(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      supabase.removeChannel(channel);
      if (timer) window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tables.join(","), onChange]);
}
