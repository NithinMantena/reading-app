import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { isConfigured, supabase } from "../lib/supabase";
import { api, ApiClientError } from "../lib/api";
import type { Settings } from "../lib/types";

export type AuthStatus = "unconfigured" | "loading" | "signed_out" | "not_owner" | "ready";

interface AuthValue {
  status: AuthStatus;
  session: Session | null;
  user: User | null;
  settings: Settings | null;
  error: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  refreshSettings: () => Promise<void>;
  setSettings: (s: Settings) => void;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [status, setStatus] = useState<AuthStatus>(isConfigured ? "loading" : "unconfigured");
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isConfigured) return;
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) setStatus("signed_out");
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => {
      setSession(s);
      if (!s) {
        setStatus("signed_out");
        setSettings(null);
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const refreshSettings = useCallback(async () => {
    try {
      const s = await api.preferences.get();
      setSettings(s);
      setStatus("ready");
      setError(null);
    } catch (e) {
      if (e instanceof ApiClientError && e.status === 403) setStatus("not_owner");
      else {
        setError(e instanceof Error ? e.message : String(e));
        setStatus("ready");
      }
    }
  }, []);

  useEffect(() => {
    if (session) void refreshSettings();
  }, [session, refreshSettings]);

  const signIn = useCallback(async () => {
    const redirectTo = `${window.location.origin}${import.meta.env.BASE_URL}`;
    const { error } = await supabase.auth.signInWithOAuth({ provider: "github", options: { redirectTo } });
    if (error) setError(error.message);
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  const value = useMemo<AuthValue>(
    () => ({ status, session, user: session?.user ?? null, settings, error, signIn, signOut, refreshSettings, setSettings }),
    [status, session, settings, error, signIn, signOut, refreshSettings],
  );
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(AuthContext);
  if (!v) throw new Error("useAuth outside AuthProvider");
  return v;
}
